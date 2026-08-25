/**
* WDA の MJPEG ストリームを1本だけ張って、複数のブラウザに配り直す。
*
* 各ブラウザが直接 WDA を叩くと端末側の負荷と USB 帯域が視聴者数だけ増えるため、
* 上流は1接続に固定して、こちらでフレームを複製する。
*
* フレームの切り出しは JPEG のマーカー探索ではなく、各パートの Content-Length を
* 見て行う。WDA のフレームには Exif が入っていて、サムネイル由来の FFD9 を
* 誤検出する可能性があるため。
**/

var http = require('http')
var url = require('url')

var logger = require('../../../util/logger')

var log = logger.createLogger('app:ios:mjpeg')

// 視聴者が居なくなってから上流を切るまでの猶予
var LINGER_MS = 10000
// 上流が落ちたときの再接続間隔
var RECONNECT_MS = 2000

var DOWNSTREAM_BOUNDARY = 'stfiosframe'

function Relay(source) {
  this.source = source
  this.clients = []
  this.upstream = null
  this.latestFrame = null
  this.lingerTimer = null
  this.reconnectTimer = null
  this.lastFrameAt = 0
  this.lastError = null
}

Relay.prototype._parse = function(res) {
  var that = this
  var buffer = Buffer.alloc(0)
  var expecting = 0

  res.on('data', function(chunk) {
    buffer = Buffer.concat([buffer, chunk])

    var progressed = true
    while (progressed) {
      progressed = false

      if (expecting === 0) {
        // WDA はフレームの後に改行を残す。空ヘッダとして誤解釈しないよう先に落とす。
        while (buffer.length >= 2 && buffer[0] === 0x0d && buffer[1] === 0x0a) {
          buffer = buffer.slice(2)
        }

        var headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) {
          // ゴミが延々と溜まり続けるのを防ぐ
          if (buffer.length > 65536) {
            log.warn('Dropping oversized MJPEG header buffer from %s', that.source)
            buffer = Buffer.alloc(0)
          }
          return
        }

        var header = buffer.slice(0, headerEnd).toString('ascii')
        var match = /Content-Length:\s*(\d+)/i.exec(header)
        buffer = buffer.slice(headerEnd + 4)

        if (match) {
          expecting = parseInt(match[1], 10)
        }
        else {
          // 長さが分からないパートは捨てて次のヘッダを探す
          log.warn('MJPEG part without Content-Length from %s', that.source)
          progressed = true
        }
      }

      if (expecting > 0 && buffer.length >= expecting) {
        that._broadcast(buffer.slice(0, expecting))
        buffer = buffer.slice(expecting)
        expecting = 0
        progressed = true
      }
    }
  })
}

Relay.prototype._broadcast = function(frame) {
  var that = this
  that.latestFrame = frame
  that.lastFrameAt = Date.now()
  that.lastError = null

  that.clients.forEach(function(client) {
    // 詰まっている相手にはこのフレームを捨てる。遅延を溜めないため。
    if (client.busy) {
      return
    }
    that._writeFrame(client, frame)
  })
}

Relay.prototype._writeFrame = function(client, frame) {
  var ok = client.res.write(
    '--' + DOWNSTREAM_BOUNDARY + '\r\n' +
    'Content-Type: image/jpeg\r\n' +
    'Content-Length: ' + frame.length + '\r\n\r\n')

  client.res.write(frame)
  ok = client.res.write('\r\n') && ok

  if (!ok) {
    client.busy = true
    client.res.once('drain', function() {
      client.busy = false
    })
  }
}

Relay.prototype._connect = function() {
  var that = this

  if (that.upstream || that.clients.length === 0) {
    return
  }

  var target = url.parse(that.source)
  log.info('Connecting to MJPEG source %s', that.source)

  var req = http.get({
    host: target.hostname
  , port: target.port
  , path: target.path
  , timeout: 15000
  }, function(res) {
    if (res.statusCode !== 200) {
      that.lastError = 'HTTP ' + res.statusCode
      log.error('MJPEG source %s returned %d', that.source, res.statusCode)
      res.resume()
      that._scheduleReconnect()
      return
    }

    log.info('MJPEG source %s connected', that.source)
    that._parse(res)

    res.on('end', function() {
      log.warn('MJPEG source %s ended', that.source)
      that.upstream = null
      that._scheduleReconnect()
    })
    res.on('error', function(err) {
      log.warn('MJPEG source %s errored: %s', that.source, err.message)
      that.upstream = null
      that._scheduleReconnect()
    })
  })

  req.on('timeout', function() {
    req.destroy(new Error('timeout'))
  })
  req.on('error', function(err) {
    that.lastError = err.message
    log.warn('MJPEG source %s unreachable: %s', that.source, err.message)
    that.upstream = null
    that._scheduleReconnect()
  })

  that.upstream = req
}

Relay.prototype._scheduleReconnect = function() {
  var that = this

  if (that.reconnectTimer || that.clients.length === 0) {
    return
  }

  that.reconnectTimer = setTimeout(function() {
    that.reconnectTimer = null
    that._connect()
  }, RECONNECT_MS)
}

Relay.prototype._disconnect = function() {
  if (this.upstream) {
    log.info('Closing MJPEG source %s (no viewers)', this.source)
    this.upstream.destroy()
    this.upstream = null
  }
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }
  this.latestFrame = null
}

Relay.prototype.viewerCount = function() {
  return this.clients.length
}

// 映像が生きているかの判断材料。端末が外れても上流の socket は
// すぐには壊れず、ただ新しいフレームが来なくなるだけのことがある。
Relay.prototype.stats = function() {
  return {
    viewers: this.clients.length
  , connected: !!this.upstream
  , lastFrameAt: this.lastFrameAt || null
  , staleMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null
  , lastError: this.lastError
  }
}

Relay.prototype.addClient = function(res) {
  var that = this
  var client = {res: res, busy: false}

  if (that.lingerTimer) {
    clearTimeout(that.lingerTimer)
    that.lingerTimer = null
  }

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=' + DOWNSTREAM_BOUNDARY
  , 'Cache-Control': 'no-store, no-cache, must-revalidate'
  , Pragma: 'no-cache'
  , Connection: 'close'
  })

  that.clients.push(client)
  log.info('MJPEG viewer joined %s (%d total)', that.source, that.clients.length)

  // 次のフレームを待たずに直近の1枚を出して、開いた瞬間に絵が出るようにする
  if (that.latestFrame) {
    that._writeFrame(client, that.latestFrame)
  }

  function remove() {
    var index = that.clients.indexOf(client)
    if (index === -1) {
      return
    }
    that.clients.splice(index, 1)
    log.info('MJPEG viewer left %s (%d left)', that.source, that.clients.length)

    if (that.clients.length === 0 && !that.lingerTimer) {
      that.lingerTimer = setTimeout(function() {
        that.lingerTimer = null
        if (that.clients.length === 0) {
          that._disconnect()
        }
      }, LINGER_MS)
    }
  }

  res.on('close', remove)
  res.on('error', remove)

  that._connect()
}

module.exports = function() {
  var relays = {}

  return {
    get: function(id, source) {
      if (!relays[id]) {
        relays[id] = new Relay(source)
      }
      return relays[id]
    }
  }
}
