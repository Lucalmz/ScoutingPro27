const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function getChromeExecutablePath() {
  const platform = os.platform();
  if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return '/usr/bin/google-chrome';
}

async function runTest() {
  console.log('Starting dev server...');
  const npmCmd = os.platform() === 'win32' ? 'npm.cmd' : 'npm';
  const server = spawn(npmCmd, ['run', 'dev'], { cwd: __dirname, shell: false });
  
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    console.log('puppeteer-core not found, falling back to puppeteer in frontend');
    puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer-core'));
  }

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    executablePath: getChromeExecutablePath(),
    headless: "new"
  });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err.toString()));
  
  try {
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });
    console.log('Page loaded successfully.');
    
    // Check if event list exists
    const eventCards = await page.$$('.event-card');
    console.log(`Found ${eventCards.length} event cards.`);
    
    if (eventCards.length > 0) {
      const display = await page.evaluate(el => getComputedStyle(el).display, eventCards[0]);
      const opacity = await page.evaluate(el => getComputedStyle(el).opacity, eventCards[0]);
      console.log(`First card display: ${display}, opacity: ${opacity}`);
    }
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await browser.close();
    server.kill();
  }
}

runTest();
