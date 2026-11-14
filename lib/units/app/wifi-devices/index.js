/**
* 設定画面の「Wi-Fi 端末」タブ（管理者だけ）が呼ぶルーター。
* 中身は lib/util/wifidevices にあり、API の /api/v1/wifi-devices も同じものを使う。
**/

var express = require('express')

var logger = require('../../../util/logger')
var wifidevices = require('../../../util/wifidevices')

var log = logger.createLogger('app:wifi-devices')

var BAD_ADDRESS = '社内 LAN の IPv4 アドレスを「192.168.1.146」か「192.168.1.146:5555」の形で入れてください'

module.exports = function(options) {
  var router = new express.Router()
  var service = wifidevices({adbHost: options.adbHost, adbPort: options.adbPort})

  function fail(res) {
    return function(err) {
      log.warn('Wi-Fi device request failed: %s', err.message)
      res.status(500).json({success: false, description: err.message})
    }
  }

  function requireAdmin(req, res, next) {
    if (!req.user || req.user.privilege !== 'admin') {
      res.status(403).json({success: false, description: '管理者だけが使えます'})
      return
    }
    next()
  }

  router.use(requireAdmin)

  router.get('/', function(req, res) {
    service.list().then(function(devices) {
      res.json({success: true, file: wifidevices.path(), devices: devices})
    }).catch(fail(res))
  })

  // 追加する。既に一覧にあれば connect だけやり直す
  router.post('/', function(req, res) {
    var address = wifidevices.normalize(req.body && req.body.address)
    if (!address) {
      res.status(400).json({success: false, description: BAD_ADDRESS})
      return
    }
    log.info('Adding Wi-Fi device %s (by %s)', address, req.user.email)
    service.add(address).then(function(device) {
      res.json({success: true, device: device})
    }).catch(fail(res))
  })

  router.delete('/:address', function(req, res) {
    var address = wifidevices.normalize(req.params.address) || String(req.params.address).trim()
    log.info('Removing Wi-Fi device %s (by %s)', address, req.user.email)
    service.remove(address).then(function(removed) {
      res.json({success: true, removed: removed})
    }).catch(fail(res))
  })

  return router
}
