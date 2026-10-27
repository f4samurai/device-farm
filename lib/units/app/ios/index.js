/**
* iOS 端末の画面表示と操作を提供するルーター。
*
* Android 側の仕組みは minicap / minitouch 前提で iOS には使えないため、
* 画面と操作は設定ファイルに書いた WDA を直接叩く独立した経路にしてある。
* 端末一覧と占有だけは STF に乗せている（ios-provider unit が UDID を serial として登録する）。
* 操作は STF でその端末を占有している本人にしか許さない。見るだけなら誰でもよい。
**/

var net = require('net')
var url = require('url')

var express = require('express')
var Promise = require('bluebird')

var logger = require('../../../util/logger')
var dbapi = require('../../../db/api')
var WdaClient = require('./wda')
var relays = require('./mjpeg-relay')()
var config = require('./config')

var log = logger.createLogger('app:ios')

// これ以上フレームが来ていなければ映像が止まっているとみなす。
// 端末を外しても上流の socket はすぐには壊れず、
// ただ新しいフレームが来なくなるだけのことがある。
var STALE_MS = 5000
var PROBE_TIMEOUT = 3000

module.exports = function() {
  var router = new express.Router()
  var devices = []
  var clients = {}

  try {
    devices = config.load()
  }
  catch (err) {
    log.error('Failed to load iOS device config: %s', err.message)
  }

  function fail(res) {
    return function(err) {
      log.warn('iOS request failed: %s', err.message)
      res.status(502).json({success: false, description: err.message})
    }
  }

  // id でも UDID（STF の serial）でも引けるようにする。端末一覧からは UDID で来る
  function lookup(req, res, next) {
    var device = devices.filter(function(candidate) {
      return candidate.id === req.params.id || candidate.udid === req.params.id
    })[0]

    if (!device) {
      res.status(404).json({success: false, description: 'Unknown iOS device'})
      return
    }

    // IP が変わっていたら（wdaUrlFile）WDA のクライアントを作り直す
    device = config.resolve(device)
    if (!clients[device.id] || clients[device.id].baseUrl !== device.wdaUrl) {
      if (clients[device.id]) {
        log.info('WDA of "%s" moved to %s', device.id, device.wdaUrl)
      }
      clients[device.id] = new WdaClient(device.wdaUrl)
    }

    req.iosDevice = device
    req.wda = clients[device.id]
    next()
  }

  // 操作は STF でこの端末を占有している本人だけ。画面側でも止めているが、
  // URL を直接叩けば通ってしまうのでここでも見る（Android の websocket unit は見ていない）
  function requireOwner(req, res, next) {
    var serial = req.iosDevice.udid

    if (!serial) {
      res.status(403).json({
        success: false
      , description: 'UDID が設定されていないため STF で占有できません'
      })
      return
    }

    dbapi.loadDeviceBySerial(serial).then(function(device) {
      var owner = device && device.owner
      if (!owner || owner.email !== req.user.email) {
        res.status(403).json({
          success: false
        , description: owner ?
            owner.name + ' が使用中です（閲覧のみ）' :
            'この端末を使用していません（閲覧のみ）'
        })
        return
      }
      next()
    }).catch(fail(res))
  }

  // ポートが接続を受け付けるかだけを見る。
  // iproxy が居ない場合と、iproxy は居るが端末が居ない場合を切り分ける。
  function probePort(target) {
    var parsed = url.parse(target)

    return new Promise(function(resolve) {
      var socket = new net.Socket()
      var done = false

      function finish(error) {
        if (done) {
          return
        }
        done = true
        socket.destroy()
        resolve({open: !error, error: error || null})
      }

      socket.setTimeout(PROBE_TIMEOUT)
      socket.once('connect', function() {
        finish(null)
      })
      socket.once('timeout', function() {
        finish('timeout')
      })
      socket.once('error', function(err) {
        finish(err.code || err.message)
      })
      socket.connect(parsed.port, parsed.hostname)
    })
  }

  router.get('/devices', function(req, res) {
    res.json({
      success: true
    , devices: devices.map(function(device) {
        return {
          id: device.id
        , name: device.name
        , udid: device.udid
        }
      })
    })
  })

  // 画面サイズと向き。クリック座標を WDA の point に直すのに使う。
  router.get('/:id/state', lookup, function(req, res) {
    var wda = req.wda

    wda.windowSize().then(function(size) {
      return wda.orientation().then(function(orientation) {
        res.json({
          success: true
        , windowSize: size
        , orientation: orientation
        , fixOrientation: req.iosDevice.fixOrientation
        })
      })
    }).catch(fail(res))
  })

  // どの層で切れているかを返す。
  // 「繋がらない」だけだと USB / iproxy / WDA のどれか分からないため。
  router.get('/:id/health', lookup, function(req, res) {
    var device = req.iosDevice
    var stream = relays.get(device.id, device.mjpegUrl).stats()

    Promise.all([
      probePort(device.wdaUrl)
    , probePort(device.mjpegUrl)
    , req.wda.status().then(function(value) {
        return {ready: value && value.ready === true, error: null}
      }).catch(function(err) {
        return {ready: false, error: err.message}
      })
    ]).then(function(results) {
      var wdaPort = results[0]
      var mjpegPort = results[1]
      var wda = results[2]

      var status = 'ok'
      var detail = null

      if (!wdaPort.open && !mjpegPort.open) {
        status = 'forward_down'
        detail = 'WDA も MJPEG も接続を拒否しています。' +
          'iproxy が落ちているか、端末が外れています'
      }
      else if (!wdaPort.open) {
        status = 'forward_down'
        detail = 'WDA のポートに繋がりません（' + wdaPort.error + '）'
      }
      else if (!mjpegPort.open) {
        status = 'forward_down'
        detail = 'MJPEG のポートに繋がりません（' + mjpegPort.error + '）'
      }
      else if (!wda.ready) {
        status = 'wda_down'
        detail = 'ポートは開いていますが WDA が応答しません。' +
          '端末が外れたか WDA が終了しています'
      }
      else if (stream.viewers > 0 && stream.staleMs !== null &&
               stream.staleMs > STALE_MS) {
        status = 'stale'
        detail = Math.round(stream.staleMs / 1000) + ' 秒フレームが届いていません'
      }

      res.json({
        success: true
      , status: status
      , detail: detail
      , layers: {wdaPort: wdaPort, mjpegPort: mjpegPort, wda: wda, stream: stream}
      })
    }).catch(fail(res))
  })

  router.get('/:id/screen.mjpeg', lookup, function(req, res) {
    var device = req.iosDevice
    var relay = relays.get(device.id, device.mjpegUrl)

    // 明示的に指定されたときだけ WDA 側で向きを補正させる。
    // 共有セッションの設定を書き換えるので既定では触らない。
    var settings = {}
    if (device.fixOrientation) {
      settings.mjpegFixOrientation = true
    }
    if (device.framerate) {
      settings.mjpegServerFramerate = device.framerate
    }
    if (device.quality) {
      settings.mjpegServerScreenshotQuality = device.quality
    }

    // 視聴者が居ない状態からの1人目でだけ送る（参加のたびに投げない）
    if (Object.keys(settings).length && relay.viewerCount() === 0) {
      req.wda.setSettings(settings).catch(function(err) {
        log.warn('Could not apply MJPEG settings: %s', err.message)
      })
    }

    relay.addClient(res)
  })

  router.post('/:id/tap', lookup, requireOwner, function(req, res) {
    req.wda.tap(req.body.x, req.body.y).then(function() {
      res.json({success: true})
    }).catch(fail(res))
  })

  router.post('/:id/swipe', lookup, requireOwner, function(req, res) {
    var points = req.body.points

    // 軌跡が来ていればそのまま再現する。無ければ2点の直線として扱う
    var action
    if (points && points.length >= 2) {
      action = req.wda.swipePath(points)
    }
    else {
      action = req.wda.swipe(
        {x: req.body.fromX, y: req.body.fromY}
      , {x: req.body.toX, y: req.body.toY}
      , req.body.duration || 0.1
      )
    }

    action.then(function() {
      res.json({success: true})
    }).catch(fail(res))
  })

  router.post('/:id/button', lookup, requireOwner, function(req, res) {
    req.wda.pressButton(req.body.name || 'home').then(function() {
      res.json({success: true})
    }).catch(fail(res))
  })

  router.post('/:id/text', lookup, requireOwner, function(req, res) {
    req.wda.sendKeys(req.body.text || '').then(function() {
      res.json({success: true})
    }).catch(fail(res))
  })

  return router
}
