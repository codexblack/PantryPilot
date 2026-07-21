const { expo } = require('./app.json');

module.exports = () => ({
  ...expo,
  android: {
    ...expo.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? expo.android.googleServicesFile,
  },
  ios: {
    ...expo.ios,
    googleServicesFile: process.env.GOOGLE_SERVICE_INFO_PLIST ?? expo.ios.googleServicesFile,
  },
});
