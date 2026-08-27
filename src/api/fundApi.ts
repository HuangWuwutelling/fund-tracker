import type { NavRecord } from '../types';

let jsonpCounter = 0;

/** Generic JSONP for APIs that support custom callback parameter */
function jsonpText(url: string, callbackParam = 'callback'): Promise<string> {
  return new Promise((resolve, reject) => {
    const callbackName = `__ft_jsonp_${jsonpCounter++}_${Date.now()}`;
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

// --- Fund estimate API (uses hardcoded jsonpgz callback) ---
interface FundEstimate {
  name: string;
  code: string;
  nav: number;
  lastNav: number;
  changePercent: number;
  navDate: string;
}

function loadJsonpgzScript(fundCode: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('JSONP timeout'));
    }, 10000);

    const cleanup = () => {
      clearTimeout(timeout);
      delete (window as unknown as Record<string, unknown>)['jsonpgz'];
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    // The tiantian fund API hardcodes the callback name as 'jsonpgz'
    (window as unknown as Record<string, unknown>)['jsonpgz'] = (data: unknown) => {
      cleanup();
      resolve(data);
    };

    script.src = `https://fundgz.1234567.com.cn/js/${fundCode}.js?rt=${Date.now()}`;
    script.onerror = () => {
      cleanup();
      reject(new Error(`Script load failed: ${fundCode}`));
    };

    document.head.appendChild(script);
  });
}

export async function fetchFundEstimate(fundCode: string): Promise<FundEstimate | null> {
  try {
    const data = await loadJsonpgzScript(fundCode) as Record<string, string>;
    if (!data?.fundcode) return null;
    return {
      name: data.name ?? '',
      code: data.fundcode,
      nav: parseFloat(data.gsz ?? '0'),
      lastNav: parseFloat(data.dwjz ?? '0'),
      changePercent: parseFloat(data.gszzl ?? '0'),
      navDate: data.gztime?.slice(0, 10) ?? '',
    };
  } catch {
    return null;
  }
}

// --- Historical NAV (supports custom callback param) ---
export async function fetchNavHistory(
  fundCode: string,
  startDate: string,
  endDate: string
): Promise<NavRecord[]> {
  try {
    const text = await jsonpText(
      `https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${fundCode}&page=1&sdate=${startDate}&edate=${endDate}&per=49`,
      'callback'
    );
    const records: NavRecord[] = [];
    const rowRegex = /<td>(\d{4}-\d{2}-\d{2})<\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td>/g;
    let match;
    while ((match = rowRegex.exec(text)) !== null) {
      records.push({
        date: match[1]!,
        nav: parseFloat(match[2]!),
        accNav: parseFloat(match[3]!),
      });
    }
    return records.reverse();
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
    if (i < fundCodes.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
}
