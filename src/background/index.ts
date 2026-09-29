import {
  TICK_ALARM,
  handleContentEvent,
  handleControlledTabLost,
  handlePanelCommand,
  restoreOnBoot,
  runWatchdog,
} from '../agent/agent';
import { store } from '../agent/state';
import type { ContentEvent, PanelCommand } from '../types';
import { describeError, logger } from '../utils/logger';
import { truncate } from '../utils/text';

/** 只认 bilibili.com 及其子域，避免把搜索结果页的重定向误判为"用户离开了 B 站"。 */
const BILIBILI_HOST_PATTERN = /^https?:\/\/([a-z0-9-]+\.)*bilibili\.com(\/|$)/i;

/* ------------------------------------------------------------------ */
/* 消息路由                                                           */
/*                                                                     */
/* 关键点：监听器必须在 SW 顶层同步注册，否则浏览器回收再唤醒后       */
/* 收不到消息，整个任务就断了。                                        */
/* ------------------------------------------------------------------ */

let booted = false;
let bootPromise: Promise<void> = Promise.resolve();

async function boot(): Promise<void> {
  if (booted) return;
  booted = true;

  store.setBroadcaster((snapshot) => {
    // Side Panel 没打开时这里会 reject，属于正常情况，忽略即可
    chrome.runtime.sendMessage({ kind: 'state', snapshot }).catch(() => undefined);
  });

  await restoreOnBoot();
}

bootPromise = boot();
void bootPromise;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    // 等恢复完成再处理，避免刚唤醒时读到空的初始快照
    await bootPromise;
    try {
      const response = sender.tab
        ? await handleContentEvent(message as ContentEvent, sender)
        : await handlePanelCommand(message as PanelCommand);
      sendResponse(response);
    } catch (error) {
      const text = describeError(error);
      logger.error(`处理消息失败（type=${(message as { type?: string })?.type}）：${text}`);
      sendResponse({ kind: 'ack', ok: false, error: text });
    }
  })();
  // 返回 true 保持消息通道打开，支持异步 sendResponse
  return true;
});

/* ------------------------------------------------------------------ */
/* 生命周期                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  logger.info('扩展已安装或更新，已启用「点击图标打开侧边面板」');
});

chrome.runtime.onStartup.addListener(() => {
  logger.info('浏览器启动，service worker 被唤醒');
});

// 不只是在 onInstalled 里设置：浏览器更新后 SW 可能先于 onInstalled 被唤醒
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

/* ------------------------------------------------------------------ */
/* 保活与超时 alarm                                                    */
/*                                                                     */
/* 明确不依赖 Side Panel 轮询来维持 SW 生命周期：                      */
/*   - 正常播放时由 content script 每 15s 的心跳消息唤醒 SW            */
/*   - 等待阶段由这个 alarm 兜底做超时判定                              */
/* ------------------------------------------------------------------ */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK_ALARM) return;
  void runWatchdog();
});

/* ------------------------------------------------------------------ */
/* 受控标签页监听                                                     */
/*                                                                     */
/* 用户关掉标签页或主动导航到别的网站时，暂停任务并提示，              */
/* 绝不自动去抢占其它标签页。                                          */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
  const snapshot = store.get();
  if (!snapshot.running || snapshot.controlledTabId !== tabId) return;
  void handleControlledTabLost(
    '受控的 Bilibili 标签页被关闭，任务已暂停。重新打开 Bilibili 后点「继续」即可接着播',
  );
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const snapshot = store.get();
  if (!snapshot.running || snapshot.controlledTabId !== tabId) return;

  const url = changeInfo.url;
  if (!url || BILIBILI_HOST_PATTERN.test(url)) return;

  void handleControlledTabLost(
    `受控标签页被导航到了非 Bilibili 页面（${truncate(url, 60)}），任务已暂停。回到 Bilibili 后点「继续」`,
  );
});
