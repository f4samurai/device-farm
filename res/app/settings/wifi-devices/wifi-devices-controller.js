/**
* 無線 adb の端末を管理者が追加・削除する画面（サーバ側は lib/units/app/wifi-devices）
**/

var STATES = {
  device: {label: '接続中', cls: 'label-success'}
, unauthorized: {
    label: '未承認'
  , cls: 'label-warning'
  , hint: '端末の画面に出ている「USB デバッグを許可しますか？」で「常に許可」にチェックして許可してください'
  }
, offline: {
    label: 'オフライン'
  , cls: 'label-warning'
  , hint: '端末がスリープしているか、Wi-Fi が切れています'
  }
, absent: {
    label: '未接続'
  , cls: 'label-default'
  , hint: '端末が居ない・IP が違う・adb tcpip 5555 が切れている（端末の再起動で消える）のどれか。' +
      '60 秒ごとに接続し直します'
  }
}

module.exports = function WifiDevicesCtrl($scope, $http, $interval, GenericModalService) {
  $scope.devices = []
  $scope.form = {address: ''}
  $scope.busy = false
  $scope.loading = false
  $scope.loaded = false
  $scope.message = null

  function errorText(res) {
    return (res && res.data && res.data.description) || ('HTTP ' + (res && res.status))
  }

  $scope.state = function(device) {
    return STATES[device.adb] || STATES.absent
  }

  $scope.load = function() {
    $scope.loading = true
    return $http.get('/wifi-devices').then(function(res) {
      $scope.devices = res.data.devices
      $scope.file = res.data.file
      $scope.loaded = true
    }).catch(function(res) {
      $scope.message = {type: 'danger', text: '一覧を読めませんでした: ' + errorText(res)}
    }).finally(function() {
      $scope.loading = false
    })
  }

  function report(device) {
    var state = $scope.state(device)
    if (device.adb === 'device') {
      $scope.message = {
        type: 'success'
      , text: device.address + ' に接続しました。数秒で端末一覧に出ます'
      }
      return
    }
    $scope.message = {
      type: 'warning'
    , text: device.address + ': ' + state.label +
        (device.connectError ? '（' + device.connectError + '）' : '') + '。' + (state.hint || '')
    }
  }

  // 一覧に無ければ足してから接続する。あれば接続だけやり直す
  function connect(address) {
    $scope.busy = true
    $scope.message = null
    return $http.post('/wifi-devices', {address: address}).then(function(res) {
      report(res.data.device)
      return $scope.load().then(function() {
        return true
      })
    }).catch(function(res) {
      $scope.message = {type: 'danger', text: errorText(res)}
      return false
    }).finally(function() {
      $scope.busy = false
    })
  }

  $scope.add = function() {
    connect($scope.form.address).then(function(ok) {
      if (ok) {
        $scope.form.address = ''
      }
    })
  }

  $scope.reconnect = function(device) {
    connect(device.address)
  }

  $scope.remove = function(device) {
    GenericModalService.open({
      message: device.address + ' を一覧から外し、STF から切り離します。' +
        'STF でこの端末を使っている人は使えなくなります（Jenkins の autotest には影響しません）'
    , type: 'Warning'
    , size: 'sm'
    , cancel: true
    }).then(function() {
      $scope.busy = true
      $scope.message = null
      return $http.delete('/wifi-devices/' + encodeURIComponent(device.address))
        .then(function() {
          $scope.message = {type: 'success', text: device.address + ' を外しました'}
          return $scope.load()
        })
        .catch(function(res) {
          $scope.message = {type: 'danger', text: errorText(res)}
        })
        .finally(function() {
          $scope.busy = false
        })
    }, function() {
      // キャンセル
    })
  }

  // 端末で許可した・tcpip を打ち直した結果がすぐ見えるよう、開いている間は読み直し続ける
  var timer = $interval(function() {
    if (!$scope.busy) {
      $scope.load()
    }
  }, 10000)
  $scope.$on('$destroy', function() {
    $interval.cancel(timer)
  })

  $scope.load()
}
