/**
* 無線 adb（`adb tcpip 5555`）の Android 端末を STF に追加・削除する。
* 設定画面の「Wi-Fi 端末」タブ（app unit の /wifi-devices）と
* API（/api/v1/wifi-devices）の両方がこれを使う。
*
* STF は adb server に見えている端末を自動で一覧に載せるだけで、端末を「追加」する口を持たない。
* 無線の端末は誰かが `adb connect` しないと adb server に現れないので、接続先を
* wifi-devices.txt（./list.js）に持ち、そのファイルを書き換えて STF 用の adb server に
* connect / disconnect する。起動スクリプトも同じファイルを 60 秒ごとに読んで
* connect し直すので、端末が落ちても戻ってくる。
*
* ここからはできないこと（端末側の操作が要る）: USB で `adb tcpip 5555` を打つ
* （端末を再起動すると消える）、初回の「USB デバッグを許可しますか」を端末で許可する、
* 端末の IP を固定する（serial が `IP:ポート` なので、変わると STF には別の端末として出る）。
**/

var Promise = require('bluebird')

var adbutil = require('../adbutil')
var dbapi = require('../../db/api')
var list = require('./list')

// 端末が居ない IP への connect は TCP のタイムアウトまで返ってこない。呼び出し側を待たせないよう
// ここで打ち切る（一覧には残るので、起動スクリプトが 60 秒ごとに connect し直す）
var CONNECT_TIMEOUT_MS = 10000
// connect の直後は adb server 上の状態がまだ offline のことがあるので、少し待ってから見る
var SETTLE_MS = 1500

var clients = {}

function split(address) {
  var i = address.lastIndexOf(':')
  return {host: address.slice(0, i), port: Number(address.slice(i + 1))}
}

module.exports = function(options) {
  var key = options.adbHost + ':' + options.adbPort
  if (!clients[key]) {
    clients[key] = adbutil({adbHost: options.adbHost, adbPort: options.adbPort}).client
  }
  var adb = clients[key]

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

  // API の応答は swagger で検査されるので、値の無い項目は null にせず省く
  function describe(entry, states) {
    var address = entry.address
    return dbapi.loadDeviceBySerial(address).then(function(device) {
      var result = {address: address, adb: states[address] || 'absent'}
      if (entry.addedBy) {
        result.addedBy = entry.addedBy
      }
      if (device) {
        result.stf = {present: !!device.present}
        // marketName はコード名（Pixel 9 なら tokay）になるので model を先に使う
        var model = device.model || device.marketName
        if (model) {
          result.stf.model = model
        }
        if (device.owner) {
          result.stf.owner = device.owner.name
        }
      }
      return result
    })
  }

  // connect の失敗は例外にせず、理由を connectError に入れて今の状態を返す
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
          return describe(list.find(address) || {address: address}, states)
        }).then(function(device) {
          if (error) {
            device.connectError = error
          }
          return device
        })
      })
  }

  return {
    // 一覧の全端末と、それぞれの adb・STF の状態
    list: function() {
      return adbStates().then(function(states) {
        return Promise.all(list.entries().map(function(entry) {
          return describe(entry, states)
        }))
      })
    }

    // address は normalize 済みのもの。既に一覧にあれば connect だけやり直す（足した人も変えない）
  , add: function(address, addedBy) {
      return Promise.try(function() {
        return list.add(address, addedBy)
      }).then(function(added) {
        return connect(address).then(function(device) {
          device.added = added
          return device
        })
      })
    }

    // 一覧から外し、STF 用の adb server から切り離す（Jenkins の adb server 5037 には影響しない）。
    // STF の端末の記録は「切断」として残るので、消すなら「Devices」タブから。
    // 手で書いた形の崩れた行も消せるよう、正規化できないものはファイルから外すだけにする
  , remove: function(address) {
      return Promise.try(function() {
        return list.remove(address)
      }).then(function(removed) {
        if (!list.normalize(address)) {
          return removed
        }
        var target = split(address)
        return adb.disconnect(target.host, target.port)
          .timeout(CONNECT_TIMEOUT_MS)
          .catch(function() {
            // 繋がっていなければ "no such device" になるだけ
          })
          .then(function() {
            return removed
          })
      })
    }
  }
}

module.exports.path = list.path
module.exports.normalize = list.normalize
module.exports.find = list.find

// 一覧から外せるのは管理者と、その端末を足した人だけ。足した人の記録が無い端末（起動スクリプトや手で入れたもの）は管理者だけ
module.exports.canRemove = function(user, entry) {
  return user.privilege === 'admin' || (!!entry.addedBy && entry.addedBy === user.email)
}
