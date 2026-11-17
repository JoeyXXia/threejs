async (page) => {
  // Local playback QA only. Change this workspace URL when cloning elsewhere.
  const player = await page.context().newPage();
  try {
    await player.setViewportSize({ width: 1440, height: 1100 });
    await player.goto('file:///H:/codex/%E9%A1%B9%E7%9B%AE/node-react-three/output/playwright/day-21/day-21-demo.webm');
    const video = player.locator('video');
    await video.waitFor();
    await player.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    const metadata = await video.evaluate((element) => {
      element.pause(); element.muted = true;
      return { width: element.videoWidth, height: element.videoHeight, duration: element.duration };
    });
    if (metadata.width !== 1440 || metadata.height !== 1100 || !Number.isFinite(metadata.duration) || metadata.duration <= 37) throw new Error('Unexpected recording metadata');
    const checked = [];
    for (const time of [8, 13.4, 17, 24, 29, 35]) {
      const result = await video.evaluate(async (element, target) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Seek timed out')), 10000);
          element.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
          element.currentTime = target;
        });
        await element.play();
        await new Promise((resolve) => setTimeout(resolve, 250));
        element.pause();
        if (element.error || element.readyState < 2 || element.currentTime <= target) throw new Error('Playback did not advance after seek');
        return { target, currentTime: element.currentTime, readyState: element.readyState };
      }, time);
      checked.push(result);
      await player.screenshot({ path: `output/playwright/day-21/video-frame-${time}.png` });
    }
    return { passed: true, ...metadata, checked };
  } finally { await player.close(); }
}
