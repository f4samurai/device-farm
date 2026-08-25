/**
* WebDriverAgent の REST クライアント。
*
* WDA のセッションは Airtest 等と共有される前提で、
* /status が返す既存セッションを再利用する。無い場合だけ新規に作る。
**/

var http = require('http')
var url = require('url')

var Promise = require('bluebird')

var logger = require('../../../util/logger')

var log = logger.createLogger('app:ios:wda')

// セッションが無効になったときに WDA が返すコード
var STALE_SESSION_CODES = ['invalid session id', 'no such session']

function WdaClient(baseUrl) {
  this.baseUrl = baseUrl
  this.sessionId = null
}

WdaClient.prototype.request = function(method, path, body) {
  var that = this
  var target = url.parse(that.baseUrl + path)
  var payload = body ? Buffer.from(JSON.stringify(body)) : null

  return new Promise(function(resolve, reject) {
    var req = http.request({
      host: target.hostname
    , port: target.port
    , path: target.path
    , method: method
    , timeout: 15000
    , headers: payload ? {
        'Content-Type': 'application/json'
      , 'Content-Length': payload.length
      } : {}
    }, function(res) {
      var chunks = []
      res.on('data', function(chunk) {
        chunks.push(chunk)
      })
      res.on('end', function() {
        var text = Buffer.concat(chunks).toString('utf8')
        var parsed = null
        try {
          parsed = JSON.parse(text)
        }
        catch (err) {
          reject(new Error(
            'WDA returned non-JSON (' + res.statusCode + '): ' + text.slice(0, 200)))
          return
        }
        resolve({statusCode: res.statusCode, body: parsed})
      })
    })

    req.on('timeout', function() {
      req.destroy(new Error('WDA request timed out: ' + method + ' ' + path))
    })
    req.on('error', reject)

    if (payload) {
      req.write(payload)
    }
    req.end()
  })
}

// WDA のエラー応答を Error に変換する
function unwrap(res) {
  var value = res.body && res.body.value

  if (res.statusCode >= 400 || (value && value.error)) {
    var err = new Error(
      (value && (value.message || value.error)) || ('WDA error ' + res.statusCode))
    err.wdaError = value && value.error
    throw err
  }
  return value
}

WdaClient.prototype.ensureSession = function() {
  var that = this

  if (that.sessionId) {
    return Promise.resolve(that.sessionId)
  }

  return that.request('GET', '/status').then(function(res) {
    if (res.body && res.body.sessionId) {
      that.sessionId = res.body.sessionId
      log.info('Reusing existing WDA session %s', that.sessionId)
      return that.sessionId
    }

    // 起動中のアプリをそのまま使うため capabilities は空にする
    return that.request('POST', '/session', {
      capabilities: {alwaysMatch: {}}
    }).then(function(created) {
      var value = unwrap(created)
      that.sessionId = created.body.sessionId || (value && value.sessionId)
      if (!that.sessionId) {
        throw new Error('WDA did not return a session id')
      }
      log.info('Created new WDA session %s', that.sessionId)
      return that.sessionId
    })
  })
}

// セッション付きの呼び出し。セッション切れなら1度だけ取り直して再試行する。
WdaClient.prototype.session = function(method, path, body, retried) {
  var that = this

  return that.ensureSession().then(function(sessionId) {
    return that.request(method, '/session/' + sessionId + path, body)
  }).then(function(res) {
    return unwrap(res)
  }).catch(function(err) {
    var stale = STALE_SESSION_CODES.indexOf(err.wdaError) !== -1
    if (stale && !retried) {
      log.warn('WDA session went stale, retrying once')
      that.sessionId = null
      return that.session(method, path, body, true)
    }
    throw err
  })
}

WdaClient.prototype.status = function() {
  return this.request('GET', '/status').then(unwrap)
}

WdaClient.prototype.windowSize = function() {
  return this.session('GET', '/window/size')
}

WdaClient.prototype.orientation = function() {
  return this.session('GET', '/orientation')
}

// タップは W3C の actions で送る。WDA 独自の /wda/tap/:uuid は
// バージョンによっては存在せず "Unhandled endpoint" になるため。
WdaClient.prototype.tap = function(x, y) {
  return this.session('POST', '/actions', {
    actions: [{
      type: 'pointer'
    , id: 'finger1'
    , parameters: {pointerType: 'touch'}
    , actions: [
        {type: 'pointerMove', duration: 0, origin: 'viewport', x: x, y: y}
      , {type: 'pointerDown', button: 0}
      , {type: 'pause', duration: 60}
      , {type: 'pointerUp', button: 0}
      ]
    }]
  })
}

WdaClient.prototype.swipe = function(from, to, duration) {
  return this.session('POST', '/wda/dragfromtoforduration', {
    fromX: from.x
  , fromY: from.y
  , toX: to.x
  , toY: to.y
  , duration: duration
  })
}

WdaClient.prototype.pressButton = function(name) {
  return this.session('POST', '/wda/pressButton', {name: name})
}

WdaClient.prototype.sendKeys = function(text) {
  return this.session('POST', '/wda/keys', {value: [text]})
}

WdaClient.prototype.setSettings = function(settings) {
  return this.session('POST', '/appium/settings', {settings: settings})
}

module.exports = WdaClient
