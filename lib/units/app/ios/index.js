/**
* iOS 端末の画面表示と操作を提供するルーター。
*
* STF のデバイス管理（provider / adb）には一切乗せていない。
* Android 側の仕組みは minicap / minitouch 前提で iOS には使えないため、
* 設定ファイルに書いた WDA を直接叩く独立した経路にしてある。
**/

var express = require('express')

var logger = require('../../../util/logger')
var WdaClient = require('./wda')
var relays = require('./mjpeg-relay')()
var config = require('./config')

var log = logger.createLogger('app:ios')

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

  devices.forEach(function(device) {
    clients[device.id] = new WdaClient(device.wdaUrl)
  })

  function lookup(req, res, next) {
    var device = devices.filter(function(candidate) {
      return candidate.id === req.params.id
    })[0]

    if (!device) {
      res.status(404).json({success: false, description: 'Unknown iOS device'})
      return
    }

    req.iosDevice = device
    req.wda = clients[device.id]
    next()
  }

  function fail(res) {
    return function(err) {
      log.warn('iOS request failed: %s', err.message)
      res.status(502).json({success: false, description: err.message})
    }
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

  router.get('/:id/screen.mjpeg', lookup, function(req, res) {
    var device = req.iosDevice
    var relay = relays.get(device.id, device.mjpegUrl)

    // 明示的に指定されたときだけ WDA 側で向きを補正させる。
    // 共有セッションの設定を書き換えるので既定では触らない。
    if (device.fixOrientation) {
      req.wda.setSettings({mjpegFixOrientation: true}).catch(function(err) {
        log.warn('Could not set mjpegFixOrientation: %s', err.message)
      })
    }

    relay.addClient(res)
  })

  router.post('/:id/tap', lookup, function(req, res) {
    req.wda.tap(req.body.x, req.body.y).then(function() {
      res.json({success: true})
    }).catch(fail(res))
  })

  router.post('/:id/swipe', lookup, function(req, res) {
    req.wda.swipe(
      {x: req.body.fromX, y: req.body.fromY}
    , {x: req.body.toX, y: req.body.toY}
    , req.body.duration || 0.1
    ).then(function() {
      res.json({success: true})
    }).catch(fail(res))
  })

  router.post('/:id/button', lookup, function(req, res) {
    req.wda.pressButton(req.body.name || 'home').then(function() {
      res.json({success: true})
    }).catch(fail(res))
  })

  router.post('/:id/text', lookup, function(req, res) {
    req.wda.sendKeys(req.body.text || '').then(function() {
      res.json({success: true})
    }).catch(fail(res))
  })

  return router
}
