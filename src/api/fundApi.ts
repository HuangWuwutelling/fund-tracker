import type { NavRecord } from '../types';

// JSONP callback counter for unique names
let jsonpCounter = 0;

function jsonp(url: string, callbackParam = 'callback'): Promise<string> {
  return new Promise((resolve, reject) => {
    const callbackName = `__jsonp_cb_${jsonpCounter++}_${Date.now()}`;
    const script = document.createElement('script');

    const cleanup = () => {
      delete (window as unknown as Record<string, unknown>)[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    (window as unknown as Record<string, unknown>)[callbackName] = (data: unknown) => {
      cleanup();
      resolve(typeof data === 'string' ? data : JSON.stringify(data));
    };

    script.src = `${url}${url.includes('?') ? '&' : '?'}${callbackParam}=${callbackName}`;
    script.onerror = () => {
      cleanup();
      reject(new Error(`JSONP request failed: ${url}`));
    };

    document.head.appendChild(script);
  });
}

// --- Fund info from real-time estimate API ---
interface FundEstimate {
  name: string;
  code: string;
  nav: number;        // 估算净值
  lastNav: number;    // 上一个交易日净值
  changePercent: number;
  navDate: string;
}

export async function fetchFundEstimate(fundCode: string): Promise<FundEstimate | null> {
  try {
    const text = await jsonp(`https://fundgz.1234567.com.cn/js/${fundCode}.js`, 'callback');
    // Response is JSONP: jsonpgz({...});
    const match = text.match(/jsonpgz\((.*)\)/);
    if (!match?.[1]) return null;
    const data = JSON.parse(match[1]);
    return {
      name: data.name,
      code: data.fundcode,
      nav: parseFloat(data.gsz),
      lastNav: parseFloat(data.dwjz),
      changePercent: parseFloat(data.gszzl),
      navDate: data.gztime?.slice(0, 10) ?? '',
    };
  } catch {
    return null;
  }
}

// --- Fund basic info (name, type) from search API ---
interface FundInfo {
  code: string;
  name: string;
  type: string;
}

export async function fetchFundInfo(fundCode: string): Promise<FundInfo | null> {
  // Try the estimate API first - it returns name
  const estimate = await fetchFundEstimate(fundCode);
  if (estimate) {
    return {
      code: estimate.code,
      name: estimate.name,
      type: 'unknown', // Need to determine type from other source
    };
  }
  return null;
}

// --- Historical NAV ---
export async function fetchNavHistory(
  fundCode: string,
  startDate: string,
  endDate: string
): Promise<NavRecord[]> {
  try {
    const text = await jsonp(
      `https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${fundCode}&page=1&sdate=${startDate}&edate=${endDate}&per=49`,
      'callback'
    );
    // Response is HTML table wrapped in JSONP - parse it
    const records: NavRecord[] = [];
    // Match table rows: <td>date</td><td>nav</td><td>accNav</td>...
    const rowRegex = /<td>(\d{4}-\d{2}-\d{2})<\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td>/g;
    let match;
    while ((match = rowRegex.exec(text)) !== null) {
      records.push({
        date: match[1]!,
        nav: parseFloat(match[2]!),
        accNav: parseFloat(match[3]!),
      });
    }
    return records.reverse(); // API returns newest first, we want oldest first
  } catch {
    return [];
  }
}

// --- Batch fetch with rate limiting ---
export async function batchFetchNav(
  fundCodes: string[],
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, FundEstimate>> {
  const results = new Map<string, FundEstimate>();

  for (let i = 0; i < fundCodes.length; i++) {
    const code = fundCodes[i]!;
    const estimate = await fetchFundEstimate(code);
    if (estimate) {
      results.set(code, estimate);
    }
    onProgress?.(i + 1, fundCodes.length);
    // Rate limit: 500ms between requests
    if (i < fundCodes.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
}
