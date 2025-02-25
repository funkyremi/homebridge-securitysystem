const customServices = require('./customServices');
const customCharacteristics = require('./customCharacteristics');

const fetch = require('node-fetch');
const storage = require('node-persist');
const packageJson = require('./package.json');
const express = require('express');
const basicAuth = require('express-basic-auth');
const app = express();

let Service, Characteristic, CustomService, CustomCharacteristic;
let homebridgePersistPath;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  CustomCharacteristic = customCharacteristics.CustomCharacteristic(Characteristic);
  CustomService = customServices.CustomService(Service, Characteristic, CustomCharacteristic);

  homebridgePersistPath = homebridge.user.persistPath();

  homebridge.registerAccessory('homebridge-securitysystem', 'Security system', SecuritySystem);
};

function SecuritySystem(log, config) {
  // Options
  this.log = log;
  this.name = config.name;
  this.defaultState = config.default_mode;
  this.armSeconds = config.arm_seconds;
  this.triggerSeconds = config.trigger_seconds;
  this.sirenSwitch = config.siren_switch;
  this.saveState = config.save_state;
  this.serverPort = config.server_port;
  this.webhooksUrl = config.webhooks_url;

  // Variables
  this.webhooks = false;
  this.armingEnding = false;
  this.armingEndingTimeout = null;
  this.armingTimeout = null;
  this.triggerTimeout = null;
  this.recoverState = false;

  // Check for optional options
  if (this.defaultState === undefined) {
    this.defaultState = Characteristic.SecuritySystemCurrentState.DISARMED;
  }
  else {
    this.defaultState = this.defaultState.toLowerCase();

    switch (this.defaultState) {
      case 'home':
        this.defaultState = Characteristic.SecuritySystemCurrentState.STAY_ARM;
        break;

      case 'away':
        this.defaultState = Characteristic.SecuritySystemCurrentState.AWAY_ARM;
        break;

      case 'night':
        this.defaultState = Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
        break;

      case 'off':
        this.defaultState = Characteristic.SecuritySystemCurrentState.DISARMED;
        break;

      default:
        this.log('Unknown default mode set in configuration.');
        this.defaultState = Characteristic.SecuritySystemCurrentState.DISARMED;
    }
  }

  if (this.armSeconds === undefined) {
    this.armSeconds = 0;
  }

  if (this.triggerSeconds === undefined) {
    this.triggerSeconds = 0;
  }

  if (this.sirenSwitch === undefined) {
    this.sirenSwitch = true;
  }
  else if (this.sirenSwitch === false) {
    this.sirenSwitch = false;
  }

  if (this.saveState === undefined) {
    this.saveState = false;
  }

  if (this.serverPort) {
    const username = config.username;
    const password = config.password;

    // Add auth if needed
    if (username && password) {
      const users = {};
      users[username] = password;

      app.use(basicAuth({ users }));
    }

    const targetStates = [
      Characteristic.SecuritySystemTargetState.STAY_ARM,
      Characteristic.SecuritySystemTargetState.AWAY_ARM,
      Characteristic.SecuritySystemTargetState.NIGHT_ARM,
      Characteristic.SecuritySystemTargetState.DISARM,
    ];

    // Declare route to trigger the
    // security system
    app.get('/triggered', (request, response) => {
      this.updateCurrentState(Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED);
      response.send('State updated.');
    });

    // Declare route to update target state
    app.get('/target-state/:state', (request, response) => {
      const state = Number(request.params.state);

      if (targetStates.includes(state)) {
        this.setTargetState(state, null);
        response.send('State updated.');
      }
      else {
        response.send('Invalid state.');
      }
    });

    // Start the server
    app.listen(this.serverPort, error => {
      if (error) {
        this.log('Server could not start', error);
        return;
      }
      
      this.log(`Server (${this.serverPort})`);
    });
  }

  if (this.webhooksUrl) {
    this.webhooks = true;

    this.pathHome = config.path_home;
    this.pathAway = config.path_away;
    this.pathNight = config.path_night;
    this.pathOff = config.path_off;
    this.pathTriggered = config.path_triggered;
  }

  // Log options value
  this.logState('Default', this.defaultState);
  this.log('Arm delay (' + this.armSeconds + ' second/s)');
  this.log('Trigger delay (' + this.armSeconds + ' second/s)');

  if (this.sirenSwitch) {
    this.log('Siren switch (enabled)');
  }

  if (this.webhooks) {
    this.log('Webhooks (' + this.webhooksUrl + ')');
  }

  // Security system
  this.service = new CustomService.SecuritySystem(this.name);

  this.service
    .getCharacteristic(Characteristic.SecuritySystemTargetState)
    .on('get', this.getTargetState.bind(this))
    .on('set', this.setTargetState.bind(this));

  this.service
    .getCharacteristic(Characteristic.SecuritySystemCurrentState)
    .on('get', this.getCurrentState.bind(this));

  this.service
    .getCharacteristic(CustomCharacteristic.SecuritySystemArmingState)
    .on('get', this.getTargetState.bind(this));

  this.service
    .getCharacteristic(CustomCharacteristic.SecuritySystemSirenActive)
    .on('get', this.getSirenActive.bind(this))
    .on('set', this.setSirenActive.bind(this));

  this.currentState = this.defaultState;
  this.targetState = this.defaultState;
  this.armingState = this.currentState;
  this.sirenActive = false;

  // Switch
  this.switchService = new Service.Switch('Siren');

  this.switchService
    .getCharacteristic(Characteristic.On)
    .on('get', this.getSwitchState.bind(this))
    .on('set', this.setSwitchState.bind(this));

  this.switchOn = false;

  // Accessory information
  this.accessoryInformationService = new Service.AccessoryInformation();

  this.accessoryInformationService.setCharacteristic(Characteristic.Identify, true);
  this.accessoryInformationService.setCharacteristic(Characteristic.Manufacturer, 'MiguelRipoll23');
  this.accessoryInformationService.setCharacteristic(Characteristic.Model, 'Generic');
  this.accessoryInformationService.setCharacteristic(Characteristic.Name, 'homebridge-securitysystem');
  this.accessoryInformationService.setCharacteristic(Characteristic.SerialNumber, 'Generic');
  this.accessoryInformationService.setCharacteristic(Characteristic.FirmwareRevision, packageJson.version);

  // Services
  this.services = [
    this.service,
    this.accessoryInformationService
  ];

  if (this.sirenSwitch) {
    this.services.push(this.switchService);
  }

  // Storage
  if (this.saveState) {
    this.load();
  }
}

SecuritySystem.prototype.load = async function() {
  const options = {
    'dir': homebridgePersistPath,
    'forgiveParseErrors': true
  };

  await storage.init(options)
    .then()
    .catch((error) => {
      this.log('Unable to initialize storage.');
      this.log(error);
    });

  if (storage.defaultInstance === undefined) {
    return;
  }
  
  await storage.getItem('state')
    .then(state => {
      if (state === undefined) {
        return;
      }

      this.log('State (Saved)');

      this.currentState = state.currentState;
      this.targetState = state.targetState;
      this.armingState = state.armingState;
      this.sirenActive = state.sirenActive;
      this.switchOn = state.switchOn;
    })
    .catch(error => {
      this.log('Unable to load state.');
      this.log(error);
    });
};

SecuritySystem.prototype.save = async function() {
  if (storage.defaultInstance === undefined) {
    return;
  }

  const state = {
    'currentState': this.currentState,
    'targetState': this.targetState,
    'armingState': this.armingState,
    'sirenActive': this.sirenActive,
    'switchOn': this.switchOn
  };

  await storage.setItem('state', state)
    .then()
    .catch(error => {
      this.log('Unable to save state.');
      this.log(error);
    });
};

SecuritySystem.prototype.identify = function(callback) {
  this.log('Identify');
  callback(null);
};

// Security system
SecuritySystem.prototype.getCurrentState = function(callback) {
  callback(null, this.currentState);
};

SecuritySystem.prototype.updateCurrentState = function(state) {
  this.currentState = state;
  this.service.setCharacteristic(Characteristic.SecuritySystemCurrentState, state);
  this.logState('Current', state);

  // Save state to file
  if (this.saveState) {
    this.save();
  }

  // Webhook
  if (this.webhooks) {
    this.sendWebhookEvent(state);
  }
};

SecuritySystem.prototype.logState = function(type, state) {
  switch (state) {
    case Characteristic.SecuritySystemCurrentState.STAY_ARM:
      this.log(type + ' state (Home)');
      break;

    case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
      this.log(type + ' state (Away)');
      break;

    case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
      this.log(type + ' state (Night)');
      break;

    case Characteristic.SecuritySystemCurrentState.DISARMED:
      this.log(type + ' state (Off)');
      break;

    case Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED:
      this.log(type + ' state (Alarm triggered)');
      break;

    default:
      this.log(type + ' state (Unknown state)');
  }
};

SecuritySystem.prototype.getTargetState = function(callback) {
  callback(null, this.targetState);
};

SecuritySystem.prototype.setTargetState = function(state, callback) {
  this.targetState = state;
  this.logState('Target', state);

  // Update state from remote
  if (callback === null) {
    this.service.getCharacteristic(Characteristic.SecuritySystemTargetState).updateValue(state);
  }

  // Save state to file
  if (this.saveState) {
    this.save();
  }

  // Set security system to mode
  // selected from the user
  // during triggered state
  if (this.currentState === Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED) {
    this.service.getCharacteristic(CustomCharacteristic.SecuritySystemSirenActive).updateValue(false);
    this.recoverState = true;
  }

  // Cancel pending or triggered alarm
  // if switching to a mode
  if (this.switchOn) {
    this.switchOn = false;
    this.switchService.setCharacteristic(Characteristic.On, this.switchOn);
  }

  // Clear timeouts
  if (this.armingEndingTimeout !== null) {
    clearTimeout(this.armingEndingTimeout);
  }

  if (this.armingTimeout !== null) {
    clearTimeout(this.armingTimeout);
  }

  // Update current state
  let armSeconds = 0;

  // Add arm delay if alarm is not triggered
  if (this.currentState !== Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED) {
    // Only if set to a mode excluding off
    if (state !== Characteristic.SecuritySystemCurrentState.DISARMED) {
      // Only if set from HomeKit
      if (callback !== null) {
        armSeconds = this.armSeconds;
      }
    }
  }

  // Allow sensors to abort the
  // arming if necessary
  this.armingEnding = false;

  if (this.armSeconds >= 30) {
    this.armingEndingTimeout = setTimeout(() => {
      this.armingEndingTimeout = null;
      this.armingEnding = true;
    }, (armSeconds - 15) * 1000);
  }

  // Update current state
  this.armingTimeout = setTimeout(() => {
    this.armingTimeout = null;
    this.armingEnding = false;
    this.updateCurrentState(state);
  }, armSeconds * 1000);

  // Update characteristic
  this.service.getCharacteristic(CustomCharacteristic.SecuritySystemArmingState).updateValue(state);

  if (callback !== null) {
    callback(null);
  }
};

SecuritySystem.prototype.getSirenActive = function(callback) {
  callback(null, this.sirenActive);
};

SecuritySystem.prototype.setSirenActive = function(state, callback) {
  this.sirenActive = state;
  this.sensorTriggered(state, callback);
};

SecuritySystem.prototype.sensorTriggered = function(state, callback) {
  // Save state to file
  if (this.saveState) {
    this.save();
  }

  // Abort arming due to
  // sensors still triggering
  // during last 15 seconds of arming
  if (this.armingEnding) {
    clearTimeout(this.armingTimeout);
    this.armingTimeout = null;

    this.log('Sensor/s (Triggered) [Arming aborted]');
    this.service.setCharacteristic(Characteristic.SecuritySystemTargetState, Characteristic.SecuritySystemTargetState.DISARM);
  }

  // Ignore if the security system
  // mode is off
  if (this.currentState === Characteristic.SecuritySystemCurrentState.DISARMED) {
    if (callback !== null) {
      callback('Security system not armed.');
    }

    return;
  }

  // Ignore if the security system
  // is arming
  if (this.armingTimeout !== null) {
    if (callback !== null) {
      callback('Security system not yet armed.');
    }

    return;
  }

  if (state) {
    // On
    if (this.currentState === Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED) {
      // Ignore since alarm
      // is already triggered
    }
    else {
      this.log('Sensor/s (Triggered)');

      this.triggerTimeout = setTimeout(() => {
        this.triggerTimeout = null;
        this.recoverState = false;

        this.updateCurrentState(Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED);
      }, this.triggerSeconds * 1000);
    }
  }
  else {
    // Off
    this.service.getCharacteristic(CustomCharacteristic.SecuritySystemSirenActive).updateValue(false);

    if (this.currentState === Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED) {
      if (this.recoverState === false) {
        this.service.setCharacteristic(Characteristic.SecuritySystemTargetState, Characteristic.SecuritySystemTargetState.DISARM);
      }
    }
    else {
      if (this.triggerTimeout !== null) {
        clearTimeout(this.triggerTimeout);
        this.triggerTimeout = null;

        this.log('Sensor/s (Cancelled)');
      }
    }
  }

  // Save state to file
  if (this.saveState) {
    this.save();
  }

  if (callback !== null) {
    callback(null);
  }
};

SecuritySystem.prototype.sendWebhookEvent = function(state) {
  let path = null;

  switch (state) {
    case Characteristic.SecuritySystemCurrentState.STAY_ARM:
      path = this.pathHome;
      break;

    case Characteristic.SecuritySystemCurrentState.AWAY_ARM:
      path = this.pathAway;
      break;

    case Characteristic.SecuritySystemCurrentState.NIGHT_ARM:
      path = this.pathNight;
      break;

    case Characteristic.SecuritySystemCurrentState.DISARMED:
      path = this.pathOff;
      break;

    case Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED:
      path = this.pathTriggered;
      break;
  }

  if (path === undefined || path === null) {
    this.log('Missing webhook path for target state.');
    return;
  }

  // Send GET request to server
  fetch(this.webhooksUrl + path)
    .then(response => {
      if (!response.ok) {
        throw new Error('Status code (' + response.statusCode + ')');
      }

      this.log('Webhook event (Sent)');
    })
    .catch(error => {
      this.log('Request to webhook failed. (' + path + ')');
      this.log(error);
    });
};

// Switch
SecuritySystem.prototype.getSwitchState = function(callback) {
  callback(null, this.switchOn);
};

SecuritySystem.prototype.setSwitchState = function(state, callback) {
  this.switchOn = state;
  this.sensorTriggered(state, callback);
};

// Accessory
SecuritySystem.prototype.getServices = function() {
  return this.services;
};
