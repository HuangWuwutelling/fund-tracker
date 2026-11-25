import { describe, it, expect } from 'vitest';
import { classifyFundTypeByName, classifyFundTypeBySearch } from './fundType';

/**
 * 基金类型分类是**纯领域规则**——它决定 Dashboard 饼图的分类与颜色。
 * 分类错了图表就错，但不会报错，所以特别需要测试钉住。
 */
describe('classifyFundTypeByName（仅按名称分类）', () => {
  it('QDII → qdii', () => {
    expect(classifyFundTypeByName('广发纳斯达克100(QDII)')).toBe('qdii');
    expect(classifyFundTypeByName('某QDII基金')).toBe('qdii');
  });

  it('债券类关键词 → bond', () => {
    expect(classifyFundTypeByName('某某纯债债券A')).toBe('bond');
    expect(classifyFundTypeByName('中债指数')).toBe('bond');
    expect(classifyFundTypeByName('国债ETF')).toBe('bond');
  });

  it('指数类关键词 → index', () => {
    expect(classifyFundTypeByName('沪深300指数A')).toBe('index');
    expect(classifyFundTypeByName('某某ETF联接')).toBe('index');
    expect(classifyFundTypeByName('某某LOF')).toBe('index');
  });

  it('名称不带线索 → null（不覆盖用户手动设置的类型）', () => {
    expect(classifyFundTypeByName('某某混合型')).toBeNull();
    expect(classifyFundTypeByName('')).toBeNull();
  });

  it('QDII 优先于指数（QDII 指数基金在 search 里常被标成"指数型"）', () => {
    expect(classifyFundTypeByName('广发纳斯达克100(QDII)指数')).toBe('qdii');
  });

  it('债券优先于指数', () => {
    expect(classifyFundTypeByName('某某债券指数')).toBe('bond');
  });
});

describe('classifyFundTypeBySearch（名称优先，其次 rawType）', () => {
  it('名称有线索 → 按名称分类，不看 rawType', () => {
    // search 接口把它标成"指数型"，但名称带 (QDII) → 应归 qdii
    expect(classifyFundTypeBySearch('指数型', '广发纳斯达克100(QDII)')).toBe('qdii');
  });

  it('名称无线索 → 按 rawType 分类', () => {
    expect(classifyFundTypeBySearch('QDII')).toBe('qdii');
    expect(classifyFundTypeBySearch('债券型')).toBe('bond');
    expect(classifyFundTypeBySearch('指数型')).toBe('index');
    expect(classifyFundTypeBySearch('混合型')).toBe('mixed');
  });

  it('rawType 认大小写（search 接口的 type 字段不统一）', () => {
    expect(classifyFundTypeBySearch('qdi')).toBe('qdii');
  });

  it('rawType 认不出 → mixed', () => {
    expect(classifyFundTypeBySearch('什么都不是')).toBe('mixed');
    expect(classifyFundTypeBySearch('')).toBe('mixed');
  });

  it('名称无线索且没给 rawType 的名字 → 退回 mixed', () => {
    expect(classifyFundTypeBySearch('指数型', undefined)).toBe('index');
    expect(classifyFundTypeBySearch('混合型', undefined)).toBe('mixed');
  });
});
