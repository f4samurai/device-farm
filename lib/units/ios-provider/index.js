/**
* iOS 端末を STF の端末一覧に載せ、占有（group）に応じる unit。
*
* ios-devices.json の UDID を serial として登録する。画面と操作は app unit の /ios が
* WDA を直接叩くので、ここが受け持つのは一覧と占有だけ（Android の device worker の
* solo / group / heartbeat に当たる部分）。占有は API・画面・admin の強制解放とも
* Android と同じ経路で動く。
*
* - 端末は WDA の状態に関係なく常に「利用可能」として出す。占有は実機の予約であり、
*   WDA の再起動中でも Jenkins が占有できなければならないため。WDA の状態は /ios の画面で見る
* - iOS の版本と画面サイズは WDA の /status と /wda/screen から拾う。どちらもセッションを
*   作らない（Jenkins のテストが使っている WDA のセッションに触らない）
**/

var http = require('http')
var url = require('url')

var Promise = require('bluebird')

var logger = require('../../util/logger')
var wire = require('../../wire')
var wireutil = require('../../wire/util')
var wirerouter = require('../../wire/router')
var grouputil = require('../../util/grouputil')
var lifecycle = require('../../util/lifecycle')
var srv = require('../../util/srv')
var zmqutil = require('../../util/zmqutil')
var config = require('../app/ios/config')

// reaper の既定 30 秒より十分短く
var HEARTBEAT_MS = 10000
// 起動直後は processor がまだ居らず登場の知らせが落ちることがある。返事が無ければ出し直す
var REINTRODUCE_MS = 15000
var WDA_POLL_MS = 60000
var WDA_TIMEOUT_MS = 5000

function getJson(target) {
  var parsed = url.parse(target)

  return new Promise(function(resolve, reject) {
    var req = http.get({
      host: parsed.hostname
    , port: parsed.port
    , path: parsed.path
    , timeout: WDA_TIMEOUT_MS
    }, function(res) {
      var chunks = []
      res.on('data', function(chunk) {
        chunks.push(chunk)
      })
      res.on('end', function() {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        }
        catch (err) {
          reject(new Error('WDA returned non-JSON (' + res.statusCode + ')'))
        }
      })
    })
    req.on('timeout', function() {
      req.destroy(new Error('WDA request timed out'))
    })
    req.on('error', reject)
  })
}

module.exports = function(options) {
  var log = logger.createLogger('ios-provider')

  if (options.name) {
    logger.setGlobalIdentifier(options.name)
  }

  function connect(socket, endpoints, label) {
    return Promise.map(endpoints, function(endpoint) {
      return srv.resolve(endpoint).then(function(records) {
        return srv.attempt(records, function(record) {
          log.info('%s "%s"', label, record.url)
          socket.connect(record.url)
          return Promise.resolve(true)
        })
      })
    })
    .catch(function(err) {
      log.fatal('Unable to connect to %s endpoint', label, err)
      lifecycle.fatal()
    })
  }

  var push = zmqutil.socket('push')
  connect(push, options.endpoints.push, 'Sending output to')

  var sub = zmqutil.socket('sub')
  connect(sub, options.endpoints.sub, 'Receiving input from')

  // DeviceRegisteredMessage はここに返ってくる（Android の provider の channel に当たる）
  var providerChannel = wireutil.makePrivateChannel()
  sub.subscribe(providerChannel)

  function broadcast(message) {
    push.send([wireutil.global, wireutil.envelope(message)])
  }

  var devices = []
  try {
    devices = config.load()
  }
  catch (err) {
    log.error('Failed to load iOS device config: %s', err.message)
  }

  devices = devices.filter(function(device) {
    if (!device.udid) {
      log.warn('"%s" has no udid, not listing it in STF', device.id)
      return false
    }
    return true
  })

  function createWorker(device) {
    var serial = device.udid
    var channel = wireutil.makePrivateChannel()
    var registered = false
    var introducedAt = 0
    var owner = null
    var timeoutMs = 0
    var lastActivity = 0
    var info = {version: '', width: 0, height: 0}

    sub.subscribe(channel)

    function identity() {
      return new wire.DeviceIdentityMessage(
        serial
      , 'iOS'
      , 'Apple'
      , null
      , device.model || 'iPhone'
      , info.version
      , 'arm64'
      , info.version
      , new wire.DeviceDisplayMessage({
          id: 0
        , width: info.width
        , height: info.height
        , rotation: 0
        , xdpi: 0
        , ydpi: 0
        , fps: 0
        , density: info.scale || 0
        , secure: false
          // 画面は /ios が出すので STF の screen websocket は無い
        , url: ''
        })
      , new wire.DevicePhoneMessage({})
      , device.model || 'iPhone'
      , null
      , null
      , device.name
      )
    }

    function join(newOwner, timeout, usage) {
      if (owner && owner.email !== newOwner.email) {
        throw new grouputil.AlreadyGroupedError()
      }
      // 同じ人からの invite は延長として扱う（画面からの keepalive もこれで来る）
      lastActivity = Date.now()
      if (owner) {
        if (timeout) {
          timeoutMs = timeout
        }
        return
      }
      owner = newOwner
      // GroupMessage の timeout は ms。無ければ --group-timeout（秒）
      timeoutMs = timeout || options.groupTimeout * 1000
      log.important('"%s" is now owned by "%s"', device.name, owner.email)
      broadcast(new wire.JoinGroupMessage(serial, owner, usage))
    }

    function leave(reason) {
      if (!owner) {
        return false
      }
      log.important('"%s" is no longer owned by "%s" (reason: %s)'
      , device.name, owner.email, reason)
      broadcast(new wire.LeaveGroupMessage(serial, owner, reason))
      owner = null
      return true
    }

    var router = wirerouter()
      .on(wire.ProbeMessage, function() {
        broadcast(identity())
      })
      .on(wire.GroupMessage, function(replyChannel, message) {
        var reply = wireutil.reply(serial)
        grouputil.match({serial: serial}, message.requirements)
          .then(function() {
            join(message.owner, message.timeout, message.usage)
            push.send([replyChannel, reply.okay()])
          })
          .catch(function(err) {
            push.send([replyChannel, reply.fail(err.message)])
          })
      })
      .on(wire.AutoGroupMessage, function(replyChannel, message) {
        try {
          join(message.owner, message.timeout, message.identifier)
        }
        catch (err) {
          // 他の人が使用中
        }
      })
      .on(wire.UngroupMessage, function(replyChannel, message) {
        var reply = wireutil.reply(serial)
        grouputil.match({serial: serial}, message.requirements)
          .then(function() {
            if (!leave('ungroup_request')) {
              throw new grouputil.NoGroupError()
            }
            push.send([replyChannel, reply.okay()])
          })
          .catch(function(err) {
            push.send([replyChannel, reply.fail(err.message)])
          })
      })

    // 版本と画面サイズを WDA から拾う。取れなければ前の値のまま（一覧から消しはしない）
    function refreshInfo() {
      var wdaUrl = config.resolve(device).wdaUrl

      return Promise.all([
        getJson(wdaUrl + '/status')
      , getJson(wdaUrl + '/wda/screen')
      ])
        .spread(function(status, screen) {
          var os = (status.value || {}).os || {}
          var value = screen.value || {}
          var size = value.screenSize || {}
          var scale = value.scale || 1
          var next = {
            version: os.version || info.version
          , width: Math.round((size.width || 0) * scale) || info.width
          , height: Math.round((size.height || 0) * scale) || info.height
          , scale: scale
          }
          var changed = next.version !== info.version ||
            next.width !== info.width || next.height !== info.height
          info = next
          if (changed && registered) {
            broadcast(identity())
          }
        })
        .catch(function(err) {
          log.debug('WDA of "%s" is not reachable: %s', device.name, err.message)
        })
    }

    return {
      serial: serial
    , channel: channel
    , route: router.handler()
    , introduce: function() {
        registered = false
        introducedAt = Date.now()
        broadcast(new wire.DeviceIntroductionMessage(
          serial
        , wire.DeviceStatus.ONLINE
        , new wire.ProviderMessage(providerChannel, options.name)
        , Date.now()
        ))
      }
    , registered: function() {
        registered = true
        log.info('Registered "%s" (%s)', device.name, serial)
        broadcast(new wire.DeviceReadyMessage(serial, channel))
      }
    , tick: function() {
        if (!registered) {
          if (introducedAt && Date.now() - introducedAt > REINTRODUCE_MS) {
            log.warn('No registration for "%s" yet, introducing again', device.name)
            this.introduce()
          }
          return
        }
        broadcast(new wire.DeviceHeartbeatMessage(serial))
        if (owner && Date.now() - lastActivity > timeoutMs) {
          leave('automatic_timeout')
        }
      }
    , refreshInfo: refreshInfo
    , shutdown: function() {
        leave('device_absent')
        broadcast(new wire.DeviceAbsentMessage(serial))
      }
    }
  }

  var workers = devices.map(createWorker)
  var byChannel = Object.create(null)
  var bySerial = Object.create(null)
  workers.forEach(function(worker) {
    byChannel[worker.channel] = worker
    bySerial[worker.serial] = worker
  })

  var providerRouter = wirerouter()
    .on(wire.DeviceRegisteredMessage, function(channel, message) {
      var worker = bySerial[message.serial]
      if (worker) {
        worker.registered()
      }
    })
    .handler()

  sub.on('message', function(channel, data) {
    var key = channel.toString()
    if (key === providerChannel) {
      providerRouter(channel, data)
    }
    else if (byChannel[key]) {
      byChannel[key].route(channel, data)
    }
  })

  if (!workers.length) {
    log.info('No iOS devices with udid in "%s"', config.path())
  }

  // 版本を先に拾ってから登録する（一覧に出た時点で版本が埋まっているように）
  Promise.map(workers, function(worker) {
    return worker.refreshInfo()
  })
    .finally(function() {
      workers.forEach(function(worker) {
        worker.introduce()
      })
    })

  var heartbeat = setInterval(function() {
    workers.forEach(function(worker) {
      worker.tick()
    })
  }, HEARTBEAT_MS)

  var poll = setInterval(function() {
    workers.forEach(function(worker) {
      worker.refreshInfo()
    })
  }, WDA_POLL_MS)

  lifecycle.observe(function() {
    clearInterval(heartbeat)
    clearInterval(poll)
    workers.forEach(function(worker) {
      worker.shutdown()
    })
    // 一覧から消す知らせを送り切ってから閉じる
    return Promise.delay(500).then(function() {
      [push, sub].forEach(function(sock) {
        try {
          sock.close()
        }
        catch (err) {
          // No-op
        }
      })
    })
  })
}
