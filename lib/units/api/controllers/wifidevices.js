/**
* 無線 adb の Android 端末を追加・削除する API（/api/v1/wifi-devices）。管理者だけ。
* 中身は lib/util/wifidevices で、設定画面の「Wi-Fi 端末」タブと同じ。
*
* ★access token で来た利用者の admin 判定は securityHandlers が tags の admin で行うが、
*   ブラウザのセッションで来たときはそこを通らないので、ここでも見る
**/

var wifidevices = require('../../../util/wifidevices')
var logger = require('../../../util/logger')

const apiutil = require('../../../util/apiutil')

var log = logger.createLogger('api:controllers:wifidevices')

var BAD_ADDRESS = 'Bad Request: address must be a private LAN IPv4 address ' +
  '("192.168.1.146" or "192.168.1.146:5555")'

function isAdmin(req, res) {
  if (req.user.privilege !== apiutil.ADMIN) {
    apiutil.respond(res, 403, 'Forbidden: privileged operation (admin)')
    return false
  }
  return true
}

function service(req) {
  return wifidevices({adbHost: req.options.adbHost, adbPort: req.options.adbPort})
}

function getWifiDevices(req, res) {
  if (!isAdmin(req, res)) {
    return
  }
  service(req).list()
    .then(function(devices) {
      apiutil.respond(res, 200, 'Wi-Fi devices information', {
        file: wifidevices.path()
      , devices: devices
      })
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to get Wi-Fi devices: ', err.stack)
    })
}

function addWifiDevice(req, res) {
  if (!isAdmin(req, res)) {
    return
  }
  const address = wifidevices.normalize(apiutil.getBodyParameter(req.body, 'address'))
  if (!address) {
    apiutil.respond(res, 400, BAD_ADDRESS)
    return
  }
  log.info('Adding Wi-Fi device %s (by %s)', address, req.user.email)
  service(req).add(address)
    .then(function(device) {
      apiutil.respond(res, 200,
        device.added ? 'Added and connected (see device.adb for the state)' :
          'Already registered; reconnected (see device.adb for the state)',
        {device: device})
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to add Wi-Fi device: ', err.stack)
    })
}

function deleteWifiDevice(req, res) {
  if (!isAdmin(req, res)) {
    return
  }
  const raw = req.swagger.params.address.value
  const address = wifidevices.normalize(raw) || String(raw).trim()
  log.info('Removing Wi-Fi device %s (by %s)', address, req.user.email)
  service(req).remove(address)
    .then(function(removed) {
      if (removed) {
        apiutil.respond(res, 200, 'Removed and disconnected')
      }
      else {
        apiutil.respond(res, 404, 'Not Found (Wi-Fi device)')
      }
    })
    .catch(function(err) {
      apiutil.internalError(res, 'Failed to remove Wi-Fi device: ', err.stack)
    })
}

module.exports = {
  getWifiDevices: getWifiDevices
, addWifiDevice: addWifiDevice
, deleteWifiDevice: deleteWifiDevice
}
