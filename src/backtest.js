const moment = require('moment');
const { flatten } = require('lodash');

const helpers = require('./helpers');
const { nfoStocks } = require('./config');

const DATE_FORMAT = 'DD-MM-YYYY';
const slippage = 1 + 0.001; // 0.1%

/**
 * Algo runner for an individual stock
 *
 * @param year The year for which we are running the backtest
 * @param symbol The stock's symbol
 * @return {Promise<Array>} An array containing all the trades for this given stock
 */
async function runTest(year, symbol) {
  // We read the stock's data file...
  // this was download when we downloaded the OHLC data for all NFO stocks
  const instrument = await helpers.readFile(`${year}/${symbol}`);

  // Since the algorithm takes into account 4 day's of data points
  // we have to iterate through all but 4 ohlc enries
  const maxIteration = instrument.ohlc.length - 4;

  // array for storing all valid trades that happened for the stock
  const allTrades = [];

  // Loop through all the ohld data points and check if we get an entry or not
  // Note: The ohlc data was already sorted by date with current date on top
  for (let start = 0; start < maxIteration; start += 1) {
    // we take the current date data as d0 because
    // for backtest we need to exit the position at day open price
    const d0 = instrument.ohlc[start];

    // The d1 to d4 day's ohlc point
    const d1 = instrument.ohlc[start + 1];
    const d2 = instrument.ohlc[start + 2];
    const d3 = instrument.ohlc[start + 3];
    const d4 = instrument.ohlc[start + 4];

    // Algo Step 1: Check for a rising stock price (rally)
    if ((d1.close - d2.close) > (d2.close - d3.close)
      && (d2.close - d3.close) > (d3.close - d4.close)
      && (d1.close > d2.close)
      && (d2.close > d3.close)
      && (d3.close > d4.close)) {
      // Algo Step2: Check the percent of the rise
      const d1inc = helpers.percentChange(d2.close, d1.close);
      const d2inc = helpers.percentChange(d3.close, d2.close);
      const d3inc = helpers.percentChange(d4.close, d4.close);

      // the percentage should also increase
      if (d1inc > d2inc && d2inc > d3inc) {
        // We got an entry in our stock on d1 date :)
        const date = moment(d1.date).format(DATE_FORMAT);
        // Take the entry price with a small slippage into account
        const entry = helpers.round(d1.close * slippage);
        // Take the exit price at next day open (d0 for our case)
        const exit = d0.open;
        // calculate the pnl percent
        const pnlPercent = helpers.percentChange(entry, exit);

        // record the trade with entry/exit etc.
        allTrades.push({
          date, entry, exit, symbol, pnlPercent, change: d1inc,
        });
      }
    }
  }

  return allTrades;
}

/**
 * The function to run backtest for all NFO stocks
 *
 * @param year The year for which to run the Backtest (defaults to 2018)
 * @param shouldDownload A boolean value to indicate that we have to download the OHLC data for the given year (defaults to false)
 * @return {Promise<{yearlyPnl: number, monthlyPnl, trades}>} The result of the backtest
 */
async function runBacktest(year = '2018', shouldDownload = false) {
  helpers.log(`Starting Backtest: ${year}`);

  // download all NFO stock's OHLC data for the entire year if needed
  if (shouldDownload) {
    await helpers.downloadAllNfoStockHistoricalDataPerYear(year);
  }

  helpers.log('Running Backtest for all NFO symbols');

  // Run the backtest algo for each stock in our list of NFO stocks
  const promises = nfoStocks.map(symbol => runTest(year, symbol));
  // convert the array of arrays into a flat array structure
  const allTrades = flatten(await Promise.all(promises));
  // convert the flat array into a hash map with date as the key and all trades as the array value
  const allTradesByDates = helpers.groupByDate(allTrades);

  helpers.log('Running Backtest computation');

  const monthlyPnl = {};
  const trades = {};
  const csvLines = ['Date,PnL%'];

  // Sort the data as par dates and take the top two stocks
  Object.keys(allTradesByDates)
    // sort by dates
    .sort((d1, d2) => moment(d1, DATE_FORMAT).diff(moment(d2, DATE_FORMAT)))
    // for each date, process the trades and only take top 2 trades
    .forEach((date) => {
      const month = moment(date, DATE_FORMAT).format('MMM');
      let totalPnl = 0;

      if (!monthlyPnl[month]) monthlyPnl[month] = 0;
      if (!trades[date]) trades[date] = [];

      allTradesByDates[date]
      // sort by percent increment
        .sort((t1, t2) => t2.change - t1.change)
        // take the top two trades
        .slice(0, 2)
        // compute pnl
        .forEach((trade) => {
          helpers.log(`>> ${date} ${trade.symbol} => Entry = ${trade.entry} | Exit = ${trade.exit} | PnL = ${trade.pnlPercent}%`);
          totalPnl += trade.pnlPercent;
          trades[date].push(trade);
        });

      monthlyPnl[month] = helpers.round(monthlyPnl[month] + totalPnl);
    });

  // Convert all trades info into a CSV file so that we can open the details in excel and play around with the data
  Object.keys(trades)
    .forEach((date) => {
      const pnl = trades[date].reduce((acc, trade) => helpers.round(acc + trade.pnlPercent), 0);
      csvLines.push(`${date},${pnl}`);
    });

  // compute yearly pnl from the monthly pnl
  const yearlyPnl = Object.keys(monthlyPnl)
    .reduce((acc, month) => helpers.round(acc + monthlyPnl[month]), 0);

  const results = {
    yearlyPnl,
    monthlyPnl,
    trades,
  };

  // save the results into a file for future reference
  await helpers.writeFile(`${year}/backtest-result`, results);
  await helpers.writeFile(`${year}/backtest-result.csv`, csvLines.join('\n'));

  helpers.log(`Backtest ${year} Monthly PnL: `, monthlyPnl);
  helpers.log(`Backtest ${year} Yearly PnL: ${yearlyPnl}%`);

  return results;
}

module.exports = runBacktest;
