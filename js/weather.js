/* weather.js — météo courante via Open-Meteo (gratuit, sans clé ni compte).
   Sert surtout à orienter la boucle : partir face au vent, rentrer avec. */
(function (global) {
  'use strict';

  var API = 'https://api.open-meteo.com/v1/forecast';
  var cache = null;   // { lat, lon, t, data }

  var WMO = {
    0: 'ciel dégagé', 1: 'peu nuageux', 2: 'nuages épars', 3: 'couvert',
    45: 'brouillard', 48: 'brouillard givrant',
    51: 'bruine légère', 53: 'bruine', 55: 'bruine forte',
    56: 'bruine verglaçante', 57: 'bruine verglaçante',
    61: 'pluie faible', 63: 'pluie', 65: 'pluie forte',
    66: 'pluie verglaçante', 67: 'pluie verglaçante',
    71: 'neige faible', 73: 'neige', 75: 'neige forte', 77: 'grains de neige',
    80: 'averses', 81: 'averses', 82: 'fortes averses',
    85: 'averses de neige', 86: 'averses de neige',
    95: 'orage', 96: 'orage grêleux', 99: 'orage grêleux'
  };

  function describe(code) { return WMO[code] || 'temps variable'; }

  function current(lat, lon) {
    if (cache && Date.now() - cache.t < 15 * 60000 &&
      Geo.haversine(cache.lat, cache.lon, lat, lon) < 8000) {
      return Promise.resolve(cache.data);
    }
    var url = API + '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&current=temperature_2m,apparent_temperature,precipitation,weather_code,' +
      'wind_speed_10m,wind_direction_10m,wind_gusts_10m&timezone=auto';

    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var c = j.current;
      if (!c) throw new Error('réponse inattendue');
      var data = {
        temp: c.temperature_2m,
        feels: c.apparent_temperature,
        rain: c.precipitation,
        code: c.weather_code,
        text: describe(c.weather_code),
        windKmh: c.wind_speed_10m,
        gustKmh: c.wind_gusts_10m,
        /* Convention météo : direction D'OÙ VIENT le vent. Partir vers ce cap,
           c'est donc partir face au vent — et rentrer poussé par lui. */
        windFrom: c.wind_direction_10m
      };
      cache = { lat: lat, lon: lon, t: Date.now(), data: data };
      return data;
    });
  }

  global.Weather = { current: current, describe: describe };
})(window);
