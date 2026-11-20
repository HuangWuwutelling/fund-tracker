import { useEffect, useState } from 'react';
import { Alert, Button, message } from 'antd';
import { useStore } from '../stores';
import {
  STORAGE_ERROR_EVENT,
  STORAGE_RECOVERED_EVENT,
  hasStorageWriteFailure,
} from '../utils/storage';

/**
 * 存储写入失败的**常驻**警告条（挂在 Layout Content 顶部，全局唯一实例）。
 *
 * 为什么必须常驻而不是弹一次 toast：
 * 写入失败时 store 仍会更新内存状态——数据**还在内存里**（用户还能导出），
 * 但 localStorage 里没有，刷新页面就丢。这个"内存有、磁盘无"的分裂如果只用
 * 一个几秒就消失的 toast 提示，几乎必然被错过，代价是丢数据。
 *
 * 所以：失败 → 常驻显示直到写入恢复（STORAGE_RECOVERED_EVENT）；
 * 并且给出「立即导出备份」——导出的数据来自内存，能把这一轮改动救下来。
 */
export default function StorageErrorBanner() {
  const { exportData } = useStore();
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    // 挂载前就失败过（应用启动阶段的写入）也要显示出来
    if (hasStorageWriteFailure()) setFailedKey('启动时');
    const onError = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key ?? '未知项';
      setFailedKey(key);
    };
    const onRecovered = () => setFailedKey(null);
    window.addEventListener(STORAGE_ERROR_EVENT, onError);
    window.addEventListener(STORAGE_RECOVERED_EVENT, onRecovered);
    return () => {
      window.removeEventListener(STORAGE_ERROR_EVENT, onError);
      window.removeEventListener(STORAGE_RECOVERED_EVENT, onRecovered);
    };
  }, []);

  if (failedKey === null) return null;

  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 16 }}
      message="数据写入失败：本地存储空间不足，或被浏览器隐私设置禁用"
      description={
        <>
          最近的操作<strong>只存在于当前页面的内存里</strong>，刷新页面即会丢失。
          失败的数据源：<code>{failedKey}</code>。请立刻导出 JSON 备份（导出的内容来自内存，
          能把这一轮改动完整救下来），并到「设置 → 重置净值历史」或删除不再持有的基金腾出空间。
        </>
      }
      action={
        <Button
          size="small"
          type="primary"
          danger
          onClick={() => {
            exportData();
            message.success('已导出备份文件，请妥善保存');
          }}
        >
          立即导出备份
        </Button>
      }
    />
  );
}
