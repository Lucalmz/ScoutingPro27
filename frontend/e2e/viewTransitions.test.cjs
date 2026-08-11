const puppeteer = require('puppeteer')

async function runTest() {
  const browser = await puppeteer.launch({
    headless: 'new', // Use new headless to ensure full rendering pipeline
    defaultViewport: { width: 400, height: 800 }
  })
  const page = await browser.newPage()

  try {
    console.log('Navigating to local dev server...')
    // Assuming Vite default port
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
    
    // Bypass login if we land there
    // Bypass login by setting local storage directly
    console.log('Logging in via localStorage...')
    await page.evaluate(() => {
      localStorage.setItem('scouting_user', JSON.stringify({
        userId: 'test-user',
        userName: 'test-user',
        token: 'fake-token',
        isLoggedIn: true
      }))
    })
    
    // Using hash router, navigate to dashboard
    await page.goto('http://localhost:5173/#/dashboard', { waitUntil: 'domcontentloaded' })
    
    // check for event card
    const hasCard = await page.waitForSelector('.event-card', { timeout: 3000 }).catch(() => null)
    if (!hasCard) {
      console.log('No event cards found on dashboard, skipping test.')
      await browser.close()
      return
    }
    
    // Inject logic into the page to intercept View Transitions and capture states
    console.log('Injecting precision race condition test...')
    await page.evaluate(() => {
      window.__transitionsStarted = 0
      window.__namesCaptured = new Set()
      
      const originalStart = document.startViewTransition
      if (!originalStart) {
        window.__noViewTransitions = true
        return
      }
      
      document.startViewTransition = function(cb) {
        window.__transitionsStarted++
        const transitionNumber = window.__transitionsStarted
        const transition = originalStart.call(this, cb)
        
        transition.updateCallbackDone.then(() => {
          // Verify that view-transition-name exists right before animation plays
          const el = document.querySelector('.event-card')
          if (el && el.style.viewTransitionName && el.style.viewTransitionName !== 'none') {
            window.__namesCaptured.add(el.style.viewTransitionName)
          }
          
          // Microtask Race Injection: 
          // During the 1st transition's updateCallbackDone, fire the 2nd click.
          // During the 2nd transition's updateCallbackDone, fire the 3rd click.
          if (transitionNumber < 3) {
             const allCards = document.querySelectorAll('.event-card')
             const nextCard = allCards.length > transitionNumber ? allCards[transitionNumber] : allCards[0]
             nextCard.click()
          }
        })
        
        return transition
      }
    })

    const noSupport = await page.evaluate(() => window.__noViewTransitions)
    if (noSupport) {
      console.log('Puppeteer browser does not support View Transitions, skipping precision test.')
      await browser.close()
      return
    }

    const cards = await page.$$('.event-card')
    if (cards.length === 0) {
      console.log('No event cards found on dashboard, skipping test.')
      await browser.close()
      return
    }

    // Trigger the first click. The injected script will chain clicks 2 and 3 in the microtasks.
    console.log('Triggering the first click to start the microtask chain...')
    await cards[0].click()
    
    // Wait for the final transition to finish and cleanup to run
    console.log('Waiting for state machine to clear...')
    await page.waitForFunction(() => {
      return !document.documentElement.hasAttribute('data-direction')
    }, { timeout: 5000 })
    
    // Check results from injected script
    const results = await page.evaluate(() => {
      return {
        transitionsStarted: window.__transitionsStarted,
        namesCaptured: Array.from(window.__namesCaptured)
      }
    })
    
    if (results.transitionsStarted < 3) {
      throw new Error(`Expected at least 3 transitions due to microtask chaining, but got ${results.transitionsStarted}`)
    }
    if (results.namesCaptured.length === 0) {
      throw new Error('No view-transition-name was captured during updateCallbackDone. Morphing would have failed!')
    }
    console.log(`Captured active view-transition-names: ${results.namesCaptured.join(', ')}`)
    
    console.log('Navigating back to verify popstate fallback (root fade)...')
    // We listen to evaluate changes during back navigation
    await page.evaluate(() => {
       window.__popstateTransitionType = null
       const originalStart = document.startViewTransition
       document.startViewTransition = function(cb) {
         window.__popstateTransitionType = document.documentElement.dataset.transitionType
         return originalStart.call(this, cb)
       }
    })

    await page.goBack()
    await page.waitForSelector('.event-card', { timeout: 5000 })
    
    const popstateType = await page.evaluate(() => window.__popstateTransitionType)
    if (popstateType !== 'root') {
      throw new Error(`Expected backward navigation to fallback to 'root' transition, got: ${popstateType}`)
    }
    
    const inlineStyle = await page.evaluate(() => {
      const el = document.querySelector('.event-card')
      return el ? el.style.viewTransitionName : null
    })
    
    if (inlineStyle && inlineStyle !== 'none' && inlineStyle !== '') {
      throw new Error(`Leftover viewTransitionName found: ${inlineStyle}`)
    }
    
    console.log('✅ E2E Precision Test Passed: Active names verified, 3-click race defeated, popstate fallback verified.')
  } catch (err) {
    console.error('❌ E2E Test Failed:', err)
    process.exit(1)
  } finally {
    await browser.close()
  }
}

runTest()
