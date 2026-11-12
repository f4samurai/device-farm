/**
* 無線 adb（`adb tcpip 5555`）の Android 端末を、管理者が画面から追加・削除するルーター。
*
* STF は adb server に見えている端末を自動で一覧に載せるだけで、端末を「追加」する口を持たない。
* 無線の端末は誰かが `adb connect` しないと adb server に現れないので、接続先を
* wifi-devices.txt（./list.js）に持ち、ここでそのファイルを書き換えて STF 用の adb server に
* connect する。起動スクリプトも同じファイルを 60 秒ごとに読んで connect し直すので、
* 端末が落ちても戻ってくる。
*
* 画面からはできないこと（端末側の操作が要る）: USB で `adb tcpip 5555` を打つ
* （端末を再起動すると消える）、初回の「USB デバッグを許可しますか」を端末で許可する、
* 端末の IP を固定する（serial が `IP:ポート` なので、変わると STF には別の端末として出る）。
**/

var express = require('express')
var Promise = require('bluebird')

var logger = require('../../../util/logger')
var adbutil = require('../../../util/adbutil')
var dbapi = require('../../../db/api')
var list = require('./list')

var log = logger.createLogger('app:wifi-devices')

// 端末が居ない IP への connect は TCP のタイムアウトまで返ってこない。画面を待たせないよう
// ここで打ち切る（一覧には残るので、起動スクリプトが 60 秒ごとに connect し直す）
var CONNECT_TIMEOUT_MS = 10000
// connect の直後は adb server 上の状態がまだ offline のことがあるので、少し待ってから見る
var SETTLE_MS = 1500

module.exports = function(options) {
  var router = new express.Router()
  var adb = adbutil({adbHost: options.adbHost, adbPort: options.adbPort}).client

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

  function split(address) {
    var i = address.lastIndexOf(':')
    return {host: address.slice(0, i), port: Number(address.slice(i + 1))}
  }

  // adb server から見た状態（device / unauthorized / offline）。居なければ absent
  function adbStates() {
    return adb.listDevices().then(function(devices) {
      var states = {}
      devices.forEach(function(device) {
        states[device.id] = device.type
      })
      return states
    })
  }

  function describe(address, states) {
    return dbapi.loadDeviceBySerial(address).then(function(device) {
      return {
        address: address
      , adb: states[address] || 'absent'
      , stf: device ? {
          present: !!device.present
        , model: device.marketName || device.model || null
        , owner: device.owner ? device.owner.name : null
        } : null
      }
    })
  }

  // connect の失敗は例外にせず、理由の文字列を添えて今の状態を返す
  // （未承認は connect 自体は成功し、状態が unauthorized になる）
  function connect(address) {
    var target = split(address)
    return adb.connect(target.host, target.port)
      .timeout(CONNECT_TIMEOUT_MS)
      .then(function() {
        return null
      })
      .catch(Promise.TimeoutError, function() {
        return CONNECT_TIMEOUT_MS / 1000 + ' 秒待っても繋がりませんでした'
      })
      .catch(function(err) {
        return err.message
      })
      .delay(SETTLE_MS)
      .then(function(error) {
        return adbStates().then(function(states) {
          return describe(address, states)
        }).then(function(device) {
          device.connectError = error
          return device
        })
      })
  }

  router.use(requireAdmin)

  router.get('/', function(req, res) {
    adbStates().then(function(states) {
      return Promise.all(list.load().map(function(address) {
        return describe(address, states)
      }))
    }).then(function(devices) {
      res.json({success: true, file: list.path(), devices: devices})
    }).catch(fail(res))
  })

  // 追加する。既に一覧にあれば connect だけやり直す
  router.post('/', function(req, res) {
    var address = list.normalize(req.body && req.body.address)
    if (!address) {
      res.status(400).json({
        success: false
      , description: '社内 LAN の IPv4 アドレスを「192.168.1.146」か「192.168.1.146:5555」の形で入れてください'
      })
      return
    }

    var added
    try {
      added = list.add(address)
    }
    catch (err) {
      fail(res)(err)
      return
    }
    log.info('%s Wi-Fi device %s (by %s)',
      added ? 'Added' : 'Reconnecting', address, req.user.email)

    connect(address).then(function(device) {
      device.added = added
      res.json({success: true, device: device})
    }).catch(fail(res))
  })

  // 一覧から外し、STF 用の adb server から切り離す（Jenkins の adb server 5037 には影響しない）。
  // STF の端末の記録は「切断」として残るので、消すなら「Devices」タブから
  router.delete('/:address', function(req, res) {
    // 手で書いた形の崩れた行も消せるよう、正規化できなければそのままの文字列で探す
    var address = list.normalize(req.params.address) || String(req.params.address).trim()

    var removed
    try {
      removed = list.remove(address)
    }
    catch (err) {
      fail(res)(err)
      return
    }
    log.info('Removed Wi-Fi device %s (by %s)', address, req.user.email)

    if (!list.normalize(address)) {
      res.json({success: true, removed: removed})
      return
    }
    var target = split(address)
    adb.disconnect(target.host, target.port)
      .timeout(CONNECT_TIMEOUT_MS)
      .catch(function(err) {
        // 繋がっていなければ "no such device" になるだけ
        log.info('adb disconnect %s: %s', address, err.message)
      })
      .then(function() {
        res.json({success: true, removed: removed})
      })
  })

  return router
}
