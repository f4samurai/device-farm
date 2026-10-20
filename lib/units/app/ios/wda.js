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

// WDA は pointerMove 1回あたり約 0.2 秒の固定コストがかかる（実測）。
// なぞった点をそのまま送ると60点で11秒かかるため、形を保ったまま間引く。
var MAX_PATH_POINTS = 5
// 曲がりの少ない点を落とす閾値（pt）
var SIMPLIFY_TOLERANCE = 8
// 再現にかける時間の上限。ゆっくり長く引いた場合に
// そのまま同じ時間をかけると待たされるだけになる
var MAX_REPLAY_MS = 600

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

// 指1本の操作を W3C の actions として組み立てる。
// WDA 独自の /wda/tap や /wda/dragfromtoforduration はバージョンによって
// 存在せず "Unhandled endpoint" になるため、規格側だけを使う。
function pointerActions(steps) {
  return {
    actions: [{
      type: 'pointer'
    , id: 'finger1'
    , parameters: {pointerType: 'touch'}
    , actions: steps
    }]
  }
}

WdaClient.prototype.tapW3c = function(x, y) {
  return this.session('POST', '/actions', pointerActions([
    {type: 'pointerMove', duration: 0, origin: 'viewport', x: x, y: y}
  , {type: 'pointerDown', button: 0}
  , {type: 'pause', duration: 60}
  , {type: 'pointerUp', button: 0}
  ]))
}

// 実測で /wda/tap は 0.56 秒、W3C の actions は平均 1.10 秒。
// タップは一番よく使うので速い方を優先し、この端点を持たない
// WDA では W3C に落とす（/wda/tap/:uuid 時代の版など）
WdaClient.prototype.tap = function(x, y) {
  var that = this

  return that.session('POST', '/wda/tap', {x: x, y: y}).catch(function(err) {
    if (/Unhandled endpoint/i.test(err.message || '')) {
      log.info('/wda/tap is unavailable, falling back to W3C actions')
      return that.tapW3c(x, y)
    }
    throw err
  })
}

// 線分からの距離。間引きの判定に使う
function perpendicularDistance(point, from, to) {
  var dx = to.x - from.x
  var dy = to.y - from.y
  var len = Math.sqrt(dx * dx + dy * dy)

  if (len === 0) {
    dx = point.x - from.x
    dy = point.y - from.y
    return Math.sqrt(dx * dx + dy * dy)
  }

  return Math.abs(
    dy * point.x - dx * point.y + to.x * from.y - to.y * from.x) / len
}

// Ramer-Douglas-Peucker。曲がっているところだけ残す
function simplify(points, tolerance) {
  if (points.length < 3) {
    return points
  }

  var maxDist = 0
  var index = 0

  for (var i = 1; i < points.length - 1; i++) {
    var dist = perpendicularDistance(
      points[i], points[0], points[points.length - 1])
    if (dist > maxDist) {
      maxDist = dist
      index = i
    }
  }

  if (maxDist <= tolerance) {
    return [points[0], points[points.length - 1]]
  }

  return simplify(points.slice(0, index + 1), tolerance)
    .slice(0, -1)
    .concat(simplify(points.slice(index), tolerance))
}

// 点数と再現時間を WDA が現実的にさばける範囲に収める。
// 間引いた点の dt は足し込んで、全体の所要時間は保つ
function reducePath(points) {
  var reduced = simplify(points, SIMPLIFY_TOLERANCE)

  // それでも多い場合は等間隔で落とす
  if (reduced.length > MAX_PATH_POINTS) {
    var step = (reduced.length - 1) / (MAX_PATH_POINTS - 1)
    var picked = []
    for (var i = 0; i < MAX_PATH_POINTS; i++) {
      picked.push(reduced[Math.round(i * step)])
    }
    reduced = picked
  }

  // 元の点の dt を、残った点に割り振り直す
  var total = points.reduce(function(sum, point) {
    return sum + (point.dt || 0)
  }, 0)
  var scale = total > MAX_REPLAY_MS ? MAX_REPLAY_MS / total : 1
  var per = Math.max(1, Math.round(total * scale / (reduced.length - 1)))

  return reduced.map(function(point, index) {
    if (index === 0) {
      return {x: point.x, y: point.y}
    }
    return {x: point.x, y: point.y, dt: per}
  })
}

// マウスがなぞった軌跡を再現する。
// points は [{x, y, dt}] で、dt は前の点からの経過ミリ秒。
// 直線で置き換えると曲線やフリックの勢いが失われるため、
// 途中の点も含めて送る。
WdaClient.prototype.swipePath = function(rawPoints) {
  var points = reducePath(rawPoints)
  var steps = [
    {type: 'pointerMove', duration: 0, origin: 'viewport'
    , x: points[0].x, y: points[0].y}
  , {type: 'pointerDown', button: 0}
    // 押下を確定させてから動かす。間を置かないと iOS 側が
    // フリックと解釈したり、そもそも拾わないことがある
  , {type: 'pause', duration: 50}
  ]

  points.slice(1).forEach(function(point) {
    steps.push({
      type: 'pointerMove'
      // 実際にかかった時間で動かす。速く動かせばフリックになる
    , duration: Math.max(1, Math.min(point.dt || 16, 1000))
    , origin: 'viewport'
    , x: point.x
    , y: point.y
    })
  })

  steps.push({type: 'pointerUp', button: 0})

  return this.session('POST', '/actions', pointerActions(steps))
}

WdaClient.prototype.swipe = function(from, to, duration) {
  return this.swipePath([
    {x: from.x, y: from.y}
  , {x: to.x, y: to.y, dt: Math.round((duration || 0.1) * 1000)}
  ])
}

WdaClient.prototype.pressButton = function(name) {
  return this.session('POST', '/wda/pressButton', {name: name})
}

WdaClient.prototype.sendKeys = function(text) {
  var steps = []

  // サロゲートペア（絵文字など）を壊さないよう符号位置単位で回す
  Array.from(text || '').forEach(function(ch) {
    steps.push({type: 'keyDown', value: ch})
    steps.push({type: 'keyUp', value: ch})
  })

  if (!steps.length) {
    return Promise.resolve(null)
  }

  return this.session('POST', '/actions', {
    actions: [{type: 'key', id: 'keyboard1', actions: steps}]
  })
}

WdaClient.prototype.setSettings = function(settings) {
  return this.session('POST', '/appium/settings', {settings: settings})
}

module.exports = WdaClient
