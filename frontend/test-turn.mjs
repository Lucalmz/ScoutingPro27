import puppeteer from 'puppeteer-core';
import os from 'os';

function getChromeExecutablePath() {
  const platform = os.platform();
  if (platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  } else if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else {
    return '/usr/bin/google-chrome';
  }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: getChromeExecutablePath(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER:', msg.text()));

  await page.evaluate(async () => {
    return new Promise((resolve, reject) => {
      const pc = new RTCPeerConnection({
        iceServers: [{
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp'
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }],
        iceTransportPolicy: 'relay'
      });
      
      const timeout = setTimeout(() => {
        resolve('Timeout waiting for candidates');
      }, 5000);

      pc.onicecandidate = e => {
        if (e.candidate) {
          console.log(`Candidate: ${e.candidate.candidate}`);
          if (e.candidate.type === 'relay') {
            console.log('SUCCESS: Got relay candidate!');
            clearTimeout(timeout);
            resolve('Success');
          }
        } else {
          console.log('Gathering complete');
          clearTimeout(timeout);
          resolve('Complete without relay');
        }
      };

      pc.createDataChannel('test');
      pc.createOffer().then(offer => pc.setLocalDescription(offer));
    });
  });

  await browser.close();
})();
