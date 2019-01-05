const fs = require('fs');
const path = require('path');
const moment = require('moment');
const { KiteConnect } = require('kiteconnect');

const { kiteConfig, nfoStocks } = require('./config');

const dateFormat = 'YYYY-MM-DD hh:mm:ss';

const dataPath = path.join(__dirname, '..', 'data');
const kite = new KiteConnect(kiteConfig);
let instruments;

/**
 * Helper function to log messages
 *
 * @param message A string description of the message
 * @param [data] An optional data object that will be json serialized
 */
function log(message, data) {
  if (message instanceof Error) {
    console.error(message);
  } else {
    console.log(`AlgoTrading: ${JSON.stringify(message, null, 2)}`);
  }
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

/**
 * Read a json file from the `data/` directory. The file content will be json parsed before returning
 *
 * @param filename The name of the file (including any sub-directroy path) but excluding the .json extension.
 *                 The .json extension will be added automatically and the content will be json parsed
 * @return {Promise<any>} The json object or array
 */
function readFile(filename) {
  return new Promise((resolve, reject) => {
    const filepath = path.join(dataPath, `${filename}.json`);
    return fs.readFile(filepath, 'utf-8', (err, contents) => {
      if (err) return reject(err);
      return resolve(JSON.parse(contents));
    });
  });
}

/**
 * Write some data to a file. The data will be written to `data/` directory and if the filename contains a sub-directory path
 * then it will be created if not present and the data will be written to the sub-directory.
 *
 * If the data to be written is of string value then the filename must include a proper extension (such as .csv)
 * otherwise if the data to be written is an object then it will be JSON serialized and the extension .json will be
 * automatically appended to the filename.
 *
 * @param filename The name of the file where data will be saved. This can include a sub-directory path such as (dir/file.extension)
 *                 The extension .json will be automatically added if the data to be written is an object.
 * @param data     The data to be written to the file. Can be either an object or a string.
 * @return {Promise<any>}
 */
function writeFile(filename, data) {
  return new Promise((resolve, reject) => {
    // check if filename contains a directory path
    // create the directory if not already present
    if (filename.indexOf('/') > -1) {
      const dirname = filename.split('/')[0];
      const dirpath = path.join(dataPath, dirname);
      if (!fs.existsSync(dirpath)) fs.mkdirSync(dirpath, { recursive: true });
    }

    let fullname;
    let content;
    switch (typeof data) {
      case 'string':
        fullname = filename;
        content = data;
        break;
      case 'object':
      default:
        fullname = `${filename}.json`;
        content = JSON.stringify(data);
        break;
    }

    const filepath = path.join(dataPath, fullname);
    return fs.writeFile(filepath, content, (err) => {
      if (err) return reject(err);
      log(`File successfully written to ${filename}`);
      return resolve();
    });
  });
}

/**
 * Helper function to group an array of object with date property and convert it into a hashmap (object)
 * with date as the key and the array of items that has the same date value.
 *
 * @param array The array of objects to be grouped
 * @return {*} Object with date as key and array of items as value
 */
function groupByDate(array) {
  return array.reduce((acc, item) => {
    if (!acc[item.date]) acc[item.date] = [];
    acc[item.date].push(item);
    return acc;
  }, {});
}

/**
 * Helper function to round a number to 2 decimal places
 *
 * @param number The number to be rounded
 * @return {number} The rounded number
 */
function round(number) {
  return Math.round(number * 100) / 100;
}

/**
 * Helper function to calculate the percentage change
 *
 * @param a First number
 * @param b Second number
 * @return {number} The percent change
 */
function percentChange(a, b) {
  return round(((b - a) / a) * 100);
}

// ======================================================
// KITE
// ======================================================

/**
 * Helper function to get the Kite login URL
 *
 * @return {string} The login URL
 */
function getLoginUrl() {
  return kite.getLoginURL();
}

/**
 * Helper function to generate a valid Kite session
 *
 * @param token The token received after kite login
 * @return {Promise<*>} Promise resolves to session object or rejects with an error
 */
async function generateSession(token) {
  return kite.generateSession(token, kiteConfig.api_secret);
}

/**
 * Helper function to download all NSE instruments from Kite.
 * Upon successful download, the content will be saved to `data/instruments.json` file
 *
 * @return {Promise<*>} Promise resolves with the instruments data object or rejects with an error
 */
async function downloadInstruments() {
  log('Downloading NSE Contracts');
  instruments = await kite.getInstruments('NSE');
  await writeFile('instruments', instruments);
  return instruments;
}

/**
 * Helper function to either get the instruments from in-memory or by reading the data/instruments.json file.
 * If the `data/instruments.json` file is not present, then a fresh copy will be downloaded from Kite.
 *
 * @return {Promise<*>} Promise resolves with the instruments data object or rejects with an error
 */
async function getInstruments() {
  if (!instruments) {
    try {
      instruments = await readFile('instrument');
    } catch (e) {
      instruments = await downloadInstruments(kite);
    }
  }
  return instruments;
}

/**
 * Helper function to download historical OHLC data from Kite API.
 * Once the download is successful, the data will be written to the `data/<year>/<symbol>.json` file.
 *
 * @param symbol The symbol for which to download the data
 * @param startDate The start date of the ohlc data
 * @param endDate The end date of the ohlc data
 * @return {Promise<*>} Promise resolves empty or rejects with an error
 */
async function downloadHistoricalData(symbol, startDate, endDate) {
  const instrument = (await getInstruments()).find(i => i.tradingsymbol === symbol);
  if (!instrument) {
    return log(new Error(`No such instrument found: ${symbol}`));
  }

  log(`Downloading OHLC For ${symbol} (${instrument.instrument_token}) : ${startDate} - ${endDate}`);

  const data = await kite.getHistoricalData(instrument.instrument_token, 'day', startDate, endDate, false);
  // sort current date on top
  const ohlc = data.sort((d1, d2) => new Date(d2.date) - new Date(d1.date));

  const year = moment(endDate, dateFormat).format('YYYY');
  return writeFile(`${year}/${symbol}`, { ...instrument, ohlc });
}

/**
 * Helper function to download all NSE F&O Stocks' OHLC data from Kite API
 * Once the download is successful, the data will be written to the `data/<year>/<symbol>.json` file.
 *
 * @param startDate The start date of the ohlc data
 * @param endDate The end date of the ohlc data
 * @return {Promise<*>} Promise resolves empty or rejects with an error
 */
async function downloadAllNfoStockHistoricalData(startDate, endDate) {
  log(`Downloading All NFO Historical Data between dates ${startDate} & ${endDate}`);
  const promises = nfoStocks.map((symbol, i) => new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        await downloadHistoricalData(symbol, startDate, endDate);
        resolve();
      } catch (err) {
        reject(err);
      }
    }, 500 * i);
  }));
  await Promise.all(promises);
  log('All NFO Stocks OHLC Data downloaded successfully');
}

/**
 * Helper function to download all NSE F&O Stocks' OHLC data from Kite API for a given year
 * Once the download is successful, the data will be written to the `data/<year>/<symbol>.json` file.
 *
 * @param year The year for which to download the data
 * @return {Promise<*>} Promise resolves empty or rejects with an error
 */
async function downloadAllNfoStockHistoricalDataPerYear(year) {
  log(`Downloading All NFO Historical Data for Year ${year}`);
  const startDate = moment(`${year}-01-01 00:00:01`, dateFormat).format(dateFormat);
  const endDate = moment().format('YYYY') === year
    ? moment().format(dateFormat)
    : moment(`${year}-12-31 11:59:59`, dateFormat).format(dateFormat);

  return downloadAllNfoStockHistoricalData(startDate, endDate);
}

module.exports = {
  log,
  readFile,
  writeFile,
  groupByDate,
  round,
  percentChange,

  getLoginUrl,
  generateSession,
  downloadInstruments,
  getInstruments,
  downloadHistoricalData,
  downloadAllNfoStockHistoricalData,
  downloadAllNfoStockHistoricalDataPerYear,
};
