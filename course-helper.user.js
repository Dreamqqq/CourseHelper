// ==UserScript==
// @name         智云人才培养平台-自动刷课助手
// @namespace    http://tampermonkey.net/
// @version      3.4.0
// @description  自动播放视频、自动停留文档、自动进入下一节，支持倍速和静音
// @author       Dreamer
// @match        http://220.178.164.28:28080/course/student/study/*
// @match        http://220.178.164.28:28080/course/student/courses/*
// @grant        none
// @downloadURL  https://github.com/Dreamqqq/CourseHelper.git/main/course-helper.user.js
// @updateURL    https://github.com/Dreamqqq/CourseHelper.git/main/course-helper.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DEBUG = true;
  function log(...args) { if (DEBUG) console.log('[刷课助手]', ...args); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ==================== 配置 ====================

  const CONFIG = {
    videoSpeed: 2,
    loopWait: 3000,
    autoStart: false
  };

  const ACTIVE_BG = 'rgb(232, 243, 255)';

  // ==================== 页面识别 ====================

  const H = () => window.location.href;
  const isVideo = () => H().includes('/video');
  const isDoc = () => H().includes('/document') || H().includes('/attachment') || H().includes('/attach');
  const isList = () => H().includes('/courses/') && !isVideo() && !isDoc();

  // ==================== 生命周期管理 ====================

  let generation = 0;
  let videoForceInterval = null;
  let monitorInterval = null;
  let pendingTimeout = null;
  let paused = false;
  let lastUrl = H();

  function cleanup() {
    generation++;
    log('清理旧任务, generation =', generation);
    clearInterval(videoForceInterval); videoForceInterval = null;
    clearInterval(monitorInterval); monitorInterval = null;
    clearTimeout(pendingTimeout); pendingTimeout = null;
  }

  function safeTimeout(fn, ms) {
    const gen = generation;
    return setTimeout(() => {
      if (generation === gen) fn();
    }, ms);
  }

  // ==================== URL变化监听 ====================

  function watchUrlChange() {
    setInterval(() => {
      const cur = H();
      if (cur !== lastUrl) {
        log('URL 变化:', lastUrl, '->', cur);
        lastUrl = cur;
        cleanup();
        if (paused) {
          log('已暂停，跳过自动开始');
          updateStatus('已暂停');
          return;
        }
        if ((isVideo() || isDoc()) && (CONFIG.autoStart || CONFIG._running)) {
          log('检测到新资源页面，3秒后自动开始');
          updateStatus('3秒后自动开始...');
          pendingTimeout = safeTimeout(() => startAuto(), 3000);
        } else {
          updateStatus('课程列表');
        }
      }
    }, 1000);
  }

  // ==================== 侧边栏导航 ====================

  function getResourceItems() {
    const items = [];
    document.querySelectorAll('li').forEach(li => {
      if (!li.classList.contains('list-item')) return;
      const t = li.textContent.trim();
      if (t.length < 80 && (t.includes('视频') || t.includes('文档') || t.includes('附件'))) {
        items.push(li);
      }
    });
    return items;
  }

  function findNextResource() {
    const items = getResourceItems();
    for (let i = 0; i < items.length; i++) {
      if (window.getComputedStyle(items[i]).backgroundColor === ACTIVE_BG && i + 1 < items.length) {
        return items[i + 1];
      }
    }
    return null;
  }

  // ==================== 视频处理 ====================

  async function handleVideo() {
    const gen = generation;
    log('视频模式, gen =', gen);
    updateStatus('等待视频加载...');

    for (let i = 0; i < 60; i++) {
      if (generation !== gen) return;
      const v = document.querySelector('video');
      if (v && v.duration > 0) {
        log(`找到视频, 时长: ${Math.round(v.duration)}s`);
        applyVideoSettings(v);

        clearInterval(videoForceInterval);
        videoForceInterval = setInterval(() => {
          if (generation !== gen) { clearInterval(videoForceInterval); return; }
          if (document.contains(v)) {
            applyVideoSettings(v);
          } else {
            clearInterval(videoForceInterval);
          }
        }, 1000);

        try {
          await v.play();
          log('播放中');
        } catch (e) {
          log('自动播放失败，尝试点击播放按钮');
          const allBtns = document.querySelectorAll('button');
          for (const btn of allBtns) {
            if (btn.textContent.trim() === '播放' && btn.offsetParent !== null) {
              btn.click();
              break;
            }
          }
          await sleep(500);
          v.play().catch(() => {});
        }

        updateStatus(`视频播放中 (${CONFIG.videoSpeed}x, 静音)`);
        monitorVideo(v, gen);
        return;
      }
      await sleep(500);
    }
    log('超时未找到视频，切换');
    updateStatus('未找到视频');
    pendingTimeout = safeTimeout(() => clickNext(), CONFIG.loopWait);
  }

  function applyVideoSettings(v) {
    if (v.muted !== true) { v.muted = true; log('强制静音'); }
    if (v.playbackRate !== CONFIG.videoSpeed) { v.playbackRate = CONFIG.videoSpeed; log('强制倍速:', CONFIG.videoSpeed); }
  }

  function monitorVideo(video, gen) {
    let lastTime = -1, stallCount = 0;

    // 监听 ended 事件，防止平台循环播放导致检测不到结束
    video.addEventListener('ended', () => {
      if (generation !== gen) return;
      log('视频 ended 事件触发');
      clearInterval(monitorInterval);
      clearInterval(videoForceInterval);
      updateStatus('视频完成，准备切换...');
      pendingTimeout = safeTimeout(() => clickNext(), CONFIG.loopWait);
    });

    clearInterval(monitorInterval);
    monitorInterval = setInterval(() => {
      if (generation !== gen) { clearInterval(monitorInterval); return; }
      if (!document.contains(video)) { clearInterval(monitorInterval); clearInterval(videoForceInterval); return; }

      applyVideoSettings(video);

      // 兜底：检测平台循环播放（currentTime 从接近末尾跳回开头）
      if (lastTime > video.duration - 5 && video.currentTime < 1 && video.paused) {
        log('检测到视频循环重置，判定为结束');
        clearInterval(monitorInterval);
        clearInterval(videoForceInterval);
        updateStatus('视频完成，准备切换...');
        pendingTimeout = safeTimeout(() => clickNext(), CONFIG.loopWait);
        return;
      }

      if (!video.paused && video.currentTime === lastTime) {
        if (++stallCount > 5) { video.play().catch(() => {}); stallCount = 0; }
      } else { stallCount = 0; }
      lastTime = video.currentTime;
    }, 2000);
  }

  // ==================== 文档处理 ====================

  async function handleDocument() {
    const gen = generation;
    log('文档模式, gen =', gen);
    updateStatus('等待文档加载...');
    await sleep(2000);
    if (generation !== gen) return;

    // 附件页面（/attach）跳过，直接切换下一项
    if (H().includes('/attach')) {
      log('附件页面，跳过');
      updateStatus('附件，跳过...');
      await sleep(500);
      if (generation !== gen) return;
      clickNext();
      return;
    }

    let totalPages = 0;
    const docCtrl = document.querySelector('.doc-control');
    if (docCtrl) {
      const m = docCtrl.textContent.match(/(\d+)\s*\/\s*(\d+)/);
      if (m) totalPages = parseInt(m[2]);
    }
    if (totalPages === 0) {
      const docPage = document.querySelector('.document-page');
      if (docPage) {
        const m = docPage.textContent.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) totalPages = parseInt(m[2]);
      }
    }
    if (totalPages === 0) {
      const cr = document.querySelector('.content-right');
      if (cr) {
        const m = cr.textContent.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) totalPages = parseInt(m[2]);
      }
    }
    log(`文档总页数: ${totalPages || '?'}`);

    await docScrollToBottom(totalPages || 1, gen);
    if (generation !== gen) return;

    log('底部停留 1s');
    updateStatus('已到底, 1秒后切换...');
    await sleep(1000);
    if (generation !== gen) return;

    log('文档处理完成');
    updateStatus('文档完成，准备切换...');
    clickNext();
  }

  async function docScrollToBottom(totalPages, gen) {
    let container = null;
    const selectors = [
      '.img-list.scrollbar',
      '.img-list',
      '[class*="img-list"]',
      '.content-right.scrollbar',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 10) {
        container = el;
        log(`找到滚动容器: ${sel}`);
        break;
      }
    }
    if (!container) {
      log('未找到可滚动容器, 尝试用 window 滚动');
    }

    const targetScroll = container
      ? container.scrollHeight - container.clientHeight
      : document.documentElement.scrollHeight - window.innerHeight;
    if (targetScroll <= 0) { log('无可滚动距离'); return; }

    const scrollTime = Math.max(totalPages * 500, 2000);
    const steps = Math.max(totalPages * 2, 15);
    const stepSize = targetScroll / steps;
    const stepDelay = scrollTime / steps;

    log(`滚动: ${Math.round(targetScroll)}px, ${Math.round(scrollTime)}ms, ${steps}步`);

    for (let i = 1; i <= steps; i++) {
      if (generation !== gen) return;
      const nextPos = Math.min(stepSize * i, targetScroll);
      if (container) {
        container.scrollTop = nextPos;
      } else {
        window.scrollTo({ top: nextPos, behavior: 'auto' });
      }
      (container || document).dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(stepDelay);
    }

    if (container) {
      container.scrollTop = container.scrollHeight;
    } else {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    }
    (container || document).dispatchEvent(new Event('scroll', { bubbles: true }));
    log('滚动完毕');
  }

  // ==================== 资源切换 ====================

  function clickNext() {
    log('切换下一资源...');
    updateStatus('切换中...');

    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.includes('下一项') && b.offsetParent !== null);
    if (btn) { log('点击「下一项任务」'); btn.click(); return; }

    const next = findNextResource();
    if (next) { log('侧边栏:', next.textContent.trim().substring(0, 40)); next.click(); return; }

    const arts = document.querySelectorAll('article');
    let found = false;
    for (const a of arts) {
      const pli = a.closest('li');
      if (found) {
        a.click(); log('展开新章节');
        safeTimeout(() => {
          const first = pli?.querySelector('li.list-item');
          if (first) first.click();
        }, 1500);
        return;
      }
      if (pli && window.getComputedStyle(pli).backgroundColor === ACTIVE_BG) found = true;
    }
    showNotice('全部资源学习完毕！');
    updateStatus('已完成');
  }

  // ==================== 状态更新（更新控制面板状态文字） ====================

  function updateStatus(text) {
    const st = document.getElementById('as-status');
    if (st) st.textContent = text;
    log(text);
  }

  // ==================== 控制面板（所有页面都显示，可拖拽） ====================

  function createPanel() {
    if (document.getElementById('auto-panel')) return;
    const d = document.createElement('div');
    d.id = 'auto-panel';
    d.style.cssText = 'position:fixed;left:calc(100vw - 290px);top:calc(100vh - 320px);z-index:99999;' +
      'background:#fff;border-radius:12px;padding:0;' +
      'box-shadow:0 4px 24px rgba(0,0,0,.15);min-width:260px;max-width:300px;' +
      'font-family:-apple-system,BlinkMacSystemFont,sans-serif;user-select:none;';
    d.innerHTML = `
      <div id="auto-panel-header" style="padding:14px 18px 0 18px;cursor:move;
        display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:15px;font-weight:bold;color:#333;">🤖 自动刷课助手 v3.4</span>
        <span style="font-size:12px;color:#bbb;cursor:default;" title="拖拽标题栏可移动面板">⠿</span>
      </div>
      <div style="padding:8px 18px 18px 18px;">
        <div style="margin-bottom:8px;font-size:13px;">
          视频倍速:
          <select id="as-speed" style="margin-left:8px;padding:3px 6px;border-radius:4px;border:1px solid #ddd;">
            <option value="1">1x</option><option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option><option value="2" selected>2x</option>
            <option value="4">4x</option><option value="8">8x</option>
            <option value="16">16x</option>
          </select>
        </div>

        <button id="as-start" style="width:100%;padding:10px;background:#1890ff;color:#fff;
          border:none;border-radius:8px;font-size:14px;cursor:pointer;font-weight:bold;">开始自动学习</button>
        <button id="as-stop" style="width:100%;padding:8px;margin-top:8px;background:#ff4d4f;color:#fff;
          border:none;border-radius:8px;font-size:13px;cursor:pointer;display:none;">暂停</button>
        <div id="as-status" style="margin-top:8px;font-size:11px;color:#999;text-align:center;"></div>
      </div>
    `;
    document.body.appendChild(d);

    const header = document.getElementById('auto-panel-header');
    let dragging = false, startX = 0, startY = 0, panelLeft = 0, panelTop = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      panelLeft = d.offsetLeft;
      panelTop = d.offsetTop;
      d.style.transition = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newLeft = panelLeft + dx;
      let newTop = panelTop + dy;
      newLeft = Math.max(0, Math.min(window.innerWidth - d.offsetWidth, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - d.offsetHeight, newTop));
      d.style.left = newLeft + 'px';
      d.style.top = newTop + 'px';
    });

    window.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        d.style.transition = '';
      }
    });

    document.getElementById('as-speed').onchange = e => {
      CONFIG.videoSpeed = +e.target.value;
      const v = document.querySelector('video');
      if (v) v.playbackRate = CONFIG.videoSpeed;
    };

    document.getElementById('as-start').onclick = () => {
      if (CONFIG._running) return;
      CONFIG._running = true;
      paused = false;
      document.getElementById('as-start').style.display = 'none';
      document.getElementById('as-stop').style.display = 'block';
      startAuto();
    };
    document.getElementById('as-stop').onclick = () => {
      CONFIG._running = false;
      paused = true;
      cleanup();
      const v = document.querySelector('video');
      if (v) v.pause();
      document.getElementById('as-start').style.display = 'block';
      document.getElementById('as-stop').style.display = 'none';
      updateStatus('已暂停');
    };
  }

  function showNotice(text) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;' +
      'background:#4CAF50;color:#fff;padding:14px 22px;border-radius:8px;' +
      'font-size:15px;box-shadow:0 4px 12px rgba(0,0,0,.3);font-family:sans-serif;';
    d.textContent = text;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 8000);
  }

  async function startAuto() {
    if (isVideo()) await handleVideo();
    else if (isDoc()) await handleDocument();
    else {
      const items = getResourceItems();
      if (items.length) items[0].click();
    }
  }

  // ==================== 入口 ====================

  function main() {
    log('v3.4.0 启动, URL:', H());
    createPanel();
    watchUrlChange();

    if ((isVideo() || isDoc()) && (CONFIG.autoStart || CONFIG._running)) {
      log('检测到资源页面，3秒后自动开始');
      updateStatus('3秒后自动开始...');
      pendingTimeout = safeTimeout(() => startAuto(), 3000);
    } else {
      updateStatus('点击「开始自动学习」启动');
    }
  }

  setTimeout(main, 2000);
})();
