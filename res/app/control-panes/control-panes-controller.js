/**
* Copyright © 2019 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

module.exports =
  function ControlPanesController($scope, $rootScope, $http, gettext,
    $routeParams, $route, $timeout, $location, DeviceService, GroupService,
    ControlService, StorageService, FatalMessageService, SettingsService) {
    var sharedTabs = [
      {
        title: gettext('Screenshots')
        , icon: 'fa-camera color-skyblue'
        , templateUrl: 'control-panes/screenshots/screenshots.pug'
        , filters: ['native', 'web']
      }
      , {
        title: gettext('Automation')
        , icon: 'fa-road color-lila'
        , templateUrl: 'control-panes/automation/automation.pug'
        , filters: ['native', 'web']
      }
      , {
        title: gettext('Advanced')
        , icon: 'fa-bolt color-brown'
        , templateUrl: 'control-panes/advanced/advanced.pug'
        , filters: ['native', 'web']
      }
      , {
        title: gettext('File Explorer')
        , icon: 'fa-folder-open color-blue'
        , templateUrl: 'control-panes/explorer/explorer.pug'
        , filters: ['native', 'web']
      }
      , {
        title: gettext('Info')
        , icon: 'fa-info color-orange'
        , templateUrl: 'control-panes/info/info.pug'
        , filters: ['native', 'web']
      }
      , {
        title: gettext('AirTest')
        , icon: 'fa-android color-green'
        , templateUrl: 'control-panes/airtest/airtest.pug'
        , filters: ['native', 'web']
      }
    ]

    $scope.topTabs = [
      {
        title: gettext('Dashboard')
        , icon: 'fa-dashboard fa-fw color-pink'
        , templateUrl: 'control-panes/dashboard/dashboard.pug'
        , filters: ['native', 'web']
      }
    ].concat(angular.copy(sharedTabs))

    $scope.belowTabs = [
      {
        title: gettext('Logs')
        , icon: 'fa-list-alt color-red'
        , templateUrl: 'control-panes/logs/logs.pug'
        , filters: ['native', 'web']
      }
    ].concat(angular.copy(sharedTabs))

    $scope.device = null
    $scope.control = null
    // 閲覧のみ: 端末を占有せず画面だけ見る。control は作らない（入力を送る手段を持たない）。
    // 他人が使用中の端末は自動でこれになる。?view を付けると空いている端末でもこれで開く
    // （占有しないので、離すときの Home 押下・回転解除 = --screen-reset が起きない）
    $scope.viewOnly = false
    // device-screen は $parent.showScreen を見て推流する。通常時は DeviceControlCtrl が持つ
    $scope.showScreen = true

    var paneClosed = false

    $scope.$on('$destroy', function() {
      paneClosed = true
      $rootScope.pageTitle = null
    })

    function isViewOnly(device) {
      return 'view' in $location.search() || Boolean(device.owner && !device.using)
    }

    $scope.takeControl = function() {
      if ('view' in $location.search()) {
        // search の変更で route が reload される
        $location.search('view', null)
      }
      else {
        $route.reload()
      }
    }

    // TODO: Move this out to Ctrl.resolve
    function getDevice(serial) {
      DeviceService.get(serial, $scope)
        .then(function(device) {
          if (isViewOnly(device)) {
            $scope.viewOnly = true
            return device
          }
          return GroupService.invite(device)
        })
        .then(function(device) {
          $scope.device = device
          $scope.control = $scope.viewOnly ?
            null :
            ControlService.create(device, device.channel)

          if (!paneClosed) {
            $rootScope.pageTitle = device.enhancedName
          }

          // /control（serial なし）はこの端末を占有しに行くので、閲覧だけなら記録しない
          if (!$scope.viewOnly) {
            SettingsService.set('lastUsedDevice', serial)
          }

          return device
        })
        .catch(function() {
          $timeout(function() {
            $location.path('/')
          })
        })
    }

    getDevice($routeParams.serial)

    $scope.$watch('device.state', function(newValue, oldValue) {
      if (newValue !== oldValue) {
/* ************* fix bug: it seems automation state was forgotten ? ************* */
        if (oldValue === 'using' || oldValue === 'automation') {
/******************************************************************************/
          FatalMessageService.open($scope.device, false)
        }
      }
    }, true)
  }
