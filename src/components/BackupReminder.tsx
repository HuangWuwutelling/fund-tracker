import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Space, message } from 'antd';
import dayjs from 'dayjs';
import { useStore } from '../stores';
import * as storage from '../utils/storage';
import {
  queryAutoBackupPermission,
  runAutoBackup,
  backupNowWithGesture,
  isAutoBackupDue,
  type AutoBackupPermission,
} from '../utils/autoBackup';

/** sessionStorage 按日去重的"本次不再提醒" key（关标签页后次日恢复提醒） */
const dismissKey = (date: string) => `fund-tracker:backup-reminder-dismissed-${date}`;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

/**
 * 顶部备份提醒条（挂在 Layout Content 顶部，全局唯一实例）。
 *
 * 两条线：
 * 1. 手动备份超期提醒（P0：数据只存 localStorage，清浏览器数据即丢失，原唯一保障
 *    是 Settings 手动导出）——距上次备份超过 settings.backupReminderDays（0=关）时显示。
 * 2. 自动备份授权提示（实验性，File System Access API）——Chrome 每次会话首次写入
 *    前需重新授权；权限为 'prompt' 且已到周期时提示用户点一下授权，随后静默写入。
 *    权限已 granted 且到期时本组件在挂载时直接静默自动备份。
 */
export default function BackupReminder() {
  const { settings, exportData } = useStore();
  const today = dayjs().format('YYYY-MM-DD');

  // backupDays: null = 本设备从未备份；数字 = 距上次备份天数
  const [backupDays, setBackupDays] = useState<number | null>(null);
  const [autoPerm, setAutoPerm] = useState<AutoBackupPermission>('unsupported');
  const [autoDue, setAutoDue] = useState(false);
  const [dismissedOn, setDismissedOn] = useState<string | null>(() => {
    try { return sessionStorage.getItem(dismissKey(today)); } catch { return null; }
  });


  const refresh = useCallback(() => {
    const meta = storage.getBackupMeta();
    setBackupDays(daysSince(meta.lastBackupAt));
    setAutoDue(isAutoBackupDue(settings.backupReminderDays));
    void queryAutoBackupPermission().then(setAutoPerm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.backupReminderDays]);

  useEffect(() => { refresh(); }, [refresh]);

  // Settings 页完成导出/导入后本组件不重渲染——页面切回前台时重新读 backup-meta
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  // 启动静默自动备份：权限 granted 且已到周期（本 effect 只在授权态变化/到期变化时跑）
  useEffect(() => {
    if (autoPerm !== 'granted' || !autoDue) return;
    void runAutoBackup().then((ok) => {
      if (ok) {
        message.success('已自动备份到本地文件', 3);
        refresh();
      }
    });
  }, [autoPerm, autoDue, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBackupNow = () => {
    exportData();
    message.success('已导出备份文件（浏览器下载目录）');
    refresh();
  };

  const handleDismiss = () => {
    // value 也存日期（与 state 一致）：跨日比较 dismissedOn === today，
    // 应用开着跨过午夜后提醒条能自动恢复（key 本身也按日隔离，双保险）
    try { sessionStorage.setItem(dismissKey(today), today); } catch { /* ignore */ }
    setDismissedOn(today);
  };

  const handleGrant = async () => {
    // backupNowWithGesture 在手势链内尽早 requestPermission，授权即写
    const ok = await backupNowWithGesture();
    if (ok) {
      message.success('自动备份完成');
    } else {
      message.warning('未获得文件写入授权，本次自动备份已跳过');
    }
    refresh();
  };

  const reminderDays = settings.backupReminderDays;
  const overdue = reminderDays > 0 && (backupDays === null || backupDays >= reminderDays);
  // 与"今天"精确比较：dismissedOn 是日期字符串（value 与 key 都按日隔离）。
  // 用 !== null 会让应用跨午夜后永远保持已关闭状态，提醒条不再出现。
  const dismissed = dismissedOn === today;
  const showOverdue = overdue && !dismissed;
  const showAuthPrompt = autoPerm === 'prompt' && autoDue;
  if (!showOverdue && !showAuthPrompt) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      {showOverdue && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={handleDismiss}
          message={backupDays === null ? '本设备从未备份数据' : `已 ${backupDays} 天未备份数据`}
          description="数据仅保存在本浏览器的 localStorage，清除浏览器数据/重装系统即全部丢失。建议立即导出 JSON 备份。"
          action={
            <Space>
              <Button size="small" type="primary" onClick={handleBackupNow}>立即备份</Button>
              <Button size="small" onClick={handleDismiss}>本次不再提醒</Button>
            </Space>
          }
        />
      )}
      {showAuthPrompt && (
        <Alert
          type="info"
          showIcon
          message="自动备份待授权"
          description="浏览器要求每次会话重新授权写入备份文件。点击授权后将自动完成一次备份。"
          action={<Button size="small" type="primary" onClick={handleGrant}>授权并备份</Button>}
          style={showOverdue ? { marginTop: 8 } : undefined}
        />
      )}
    </div>
  );
}
