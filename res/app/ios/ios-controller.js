/**
* iOS 端末の画面表示と操作。
*
* 画面は WDA の MJPEG をサーバ側で中継したものを <img> で受ける。
* 操作は正規化した座標を WDA の point 座標に直して投げる。
**/

module.exports =
  function IosCtrl($scope, $http, $timeout, $interval, $window, $q) {

    $scope.devices = []
    $scope.current = null
    $scope.state = null
    $scope.streamUrl = null
    $scope.error = null
    $scope.text = ''
    // 端末が横向きのとき MJPEG は縦のまま流れてくるので表示側で回す。
    // 反時計回りが正しいことは WDA の向き補正済みスクリーンショットと
    // 突き合わせて確認済み。ただし逆向きに寝かせた場合は反転が要るため、
    // 画面上のボタンで切り替えられるようにしてある。
    $scope.rotateDir = -1
    $scope.wrapStyle = {}
    $scope.imgStyle = {}

    // 1x1 の透明 GIF。<img> を DOM から外しただけでは
    // multipart ストリームの受信が止まらずソケットが残るため、
    // src をこれに差し替えてブラウザ側に中断させる。
    var BLANK_IMAGE = 'data:image/gif;base64,' +
      'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='

    var drag = null
    var imgEl = null
    var frameSize = null
    var poll = null

    function post(path, body) {
      if (!$scope.current) {
        return $q.when(null)
      }
      $scope.error = null
      return $http.post('/ios/' + $scope.current.id + path, body)
        .catch(function(res) {
          $scope.error = (res.data && res.data.description) || '操作に失敗しました'
        })
    }

    // 表示領域と画像の大きさを決める。
    // 横向きのときは画像を90度回すため、幅と高さを入れ替えて渡す。
    function layout() {
      if (!$scope.state) {
        return
      }

      var size = $scope.state.windowSize
      var rotated = $scope.rotated
      var available = Math.max(320, ($window.innerWidth || 1280) - 420)
      var maxHeight = Math.max(320, ($window.innerHeight || 800) - 220)

      var dispWidth = Math.min(available, size.width / size.height * maxHeight)
      var dispHeight = dispWidth * size.height / size.width

      $scope.wrapStyle = {
        width: Math.round(dispWidth) + 'px'
      , height: Math.round(dispHeight) + 'px'
      }

      $scope.imgStyle = rotated ? {
        position: 'absolute'
      , left: '50%'
      , top: '50%'
      , width: Math.round(dispHeight) + 'px'
      , height: Math.round(dispWidth) + 'px'
      , transform: 'translate(-50%, -50%) rotate(' + ($scope.rotateDir * 90) + 'deg)'
      } : {
        width: Math.round(dispWidth) + 'px'
      , height: Math.round(dispHeight) + 'px'
      }
    }

    // MJPEG が回転済みで来るかどうかは WDA の mjpegFixOrientation 次第で、
    // Airtest など他の利用者が実行中に切り替えることがある。
    // ウィンドウの向きだけで決め打ちせず、実際のフレームの縦横と突き合わせる。
    function updateRotation() {
      if (!$scope.state || !frameSize || !frameSize.w || !frameSize.h) {
        $scope.rotated = false
        return
      }

      var size = $scope.state.windowSize
      $scope.rotated = (frameSize.w > frameSize.h) !== (size.width > size.height)
    }

    function loadState() {
      if (!$scope.current) {
        return
      }

      $http.get('/ios/' + $scope.current.id + '/state').then(function(res) {
        $scope.state = res.data
        updateRotation()
        layout()
      }).catch(function(res) {
        $scope.error = (res.data && res.data.description) || 'WDA に接続できません'
      })
    }

    // 端末が回されたり、上流の向き補正が切り替わっても追従できるように、
    // ウィンドウサイズとフレームの実寸を定期的に見直す。
    function watch() {
      if (imgEl && imgEl.naturalWidth &&
          (!frameSize || frameSize.w !== imgEl.naturalWidth ||
           frameSize.h !== imgEl.naturalHeight)) {
        frameSize = {w: imgEl.naturalWidth, h: imgEl.naturalHeight}
        updateRotation()
        layout()
      }
      loadState()
    }

    $scope.onStreamLoad = function(img) {
      imgEl = img
      frameSize = {w: img.naturalWidth, h: img.naturalHeight}
      updateRotation()
      layout()
      if (!$scope.$$phase) {
        $scope.$apply()
      }
    }

    $scope.select = function(device) {
      $scope.current = device
      $scope.state = null
      $scope.error = null
      imgEl = null
      frameSize = null
      $scope.rotated = false
      // 同じ URL だとブラウザが前の接続を使い回すことがあるので毎回変える
      $scope.streamUrl = '/ios/' + device.id + '/screen.mjpeg?t=' + new Date().getTime()
      loadState()
    }

    $scope.reload = function() {
      if ($scope.current) {
        $scope.select($scope.current)
      }
    }

    $scope.flipRotation = function() {
      $scope.rotateDir = -$scope.rotateDir
      layout()
    }

    // 表示領域内の位置を WDA の point 座標に直す。
    // 画像を正しい向きで出していれば、正規化した座標をそのまま
    // 現在の向きのウィンドウサイズに掛ければよい。
    function toPoint(event) {
      var rect = event.currentTarget.getBoundingClientRect()
      var size = $scope.state.windowSize

      return {
        x: Math.round((event.clientX - rect.left) / rect.width * size.width)
      , y: Math.round((event.clientY - rect.top) / rect.height * size.height)
      }
    }

    $scope.onMouseDown = function(event) {
      if (!$scope.state) {
        return
      }
      drag = {point: toPoint(event), at: new Date().getTime()}
    }

    $scope.onMouseUp = function(event) {
      if (!$scope.state || !drag) {
        return
      }

      var end = toPoint(event)
      var start = drag.point
      var elapsed = (new Date().getTime() - drag.at) / 1000
      var moved = Math.abs(end.x - start.x) + Math.abs(end.y - start.y)
      drag = null

      // 10pt 以上動いていたらスワイプ、そうでなければタップ
      if (moved > 10) {
        post('/swipe', {
          fromX: start.x
        , fromY: start.y
        , toX: end.x
        , toY: end.y
        , duration: Math.max(0.05, Math.min(elapsed, 2))
        })
      }
      else {
        post('/tap', {x: start.x, y: start.y})
      }
    }

    $scope.pressHome = function() {
      post('/button', {name: 'home'})
    }

    $scope.sendText = function() {
      if (!$scope.text) {
        return
      }
      post('/text', {text: $scope.text}).then(function() {
        $scope.text = ''
      })
    }

    $scope.onStreamError = function() {
      $scope.error = '画面ストリームが切れました。再接続してください。'
      // <img> の onerror は Angular の外から来るので明示的に反映させる
      if (!$scope.$$phase) {
        $scope.$apply()
      }
    }

    function onResize() {
      $scope.$apply(layout)
    }

    angular.element($window).on('resize', onResize)

    poll = $interval(watch, 3000)

    $http.get('/ios/devices').then(function(res) {
      $scope.devices = res.data.devices
      if ($scope.devices.length === 1) {
        $scope.select($scope.devices[0])
      }
    }).catch(function() {
      $scope.error = 'iOS 端末の一覧を取得できません'
    })

    $scope.$on('$destroy', function() {
      // ページを離れるときは必ずストリームを止める。
      // 放置するとブラウザの同時接続数（1ホスト6本）を食い潰し、
      // やがて /ios/devices すら通らなくなる
      // 1枚目が届く前に離れた場合は onload が来ておらず imgEl が空なので、
      // DOM から引き直す。切り替えが速いとこの経路に入る
      var img = imgEl || document.querySelector('.stf-ios-wrap img')
      if (img) {
        img.src = BLANK_IMAGE
      }
      $scope.streamUrl = null
      // 他のモジュールのハンドラまで外さないよう自分の分だけ指定する
      angular.element($window).off('resize', onResize)
      if (poll) {
        $interval.cancel(poll)
      }
    })

    $timeout(layout)
  }
