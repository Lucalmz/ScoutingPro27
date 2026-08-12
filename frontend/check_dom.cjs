const os = require('os');
const path = require('path');

async function runTest() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer-core'));
  }

  const browser = await puppeteer.launch({
    executablePath: os.platform() === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome',
    headless: "new"
  });
  
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('CONSOLE:', msg.text()));
  
  try {
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });
    
    // Evaluate transition on .event-card
    const hasCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('.event-card');
      if (cards.length === 0) return false;
      const computed = getComputedStyle(cards[0]);
      console.log('Card opacity:', computed.opacity);
      console.log('Card transform:', computed.transform);
      console.log('Card transition:', computed.transition);
      return true;
    });
    console.log('Has cards:', hasCards);
    
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await browser.close();
  }
}

runTest();
