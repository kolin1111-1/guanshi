// 合规边界：输入侧识别「预测涨跌 / 投资建议 / 收益承诺」类问题并改写；输出侧拦截违规表述。
// 规则刻意偏保守：宁可多拦，也不让模型输出确定性涨跌或买卖建议。

const INPUT_RULES = [
  { cat: '涨跌预测', re: /(会|能|还会|要|将|可能)(不会)?(涨|跌|反弹|回调|大涨|大跌|突破|见底|见顶)|涨吗|跌吗|还涨|还跌|走势(预测|如何)|(明天|明日|下周|后市|下个月|年底|未来).{0,8}(涨|跌|走势|点位|行情)|目标(价|点位)|能到\s*\d|看(多|空)|(何时|什么时候).{0,4}(见底|见顶|反弹)|预测|多少点/ },
  { cat: '投资建议', re: /(该|要|能|可以|值得|应该).{0,4}(买|卖|入|进场|离场|抄底|加仓|减仓|清仓|割肉|持有)|(买|卖)(什么|哪|吗)|仓位|抄底|逃顶|止损|止盈|满仓|空仓|推荐.{0,6}(股|基金|板块)|哪只|代码是多少/ },
  { cat: '收益承诺', re: /稳赚|保本|翻倍|收益率(多少|能有)|能赚(多少)?|必涨|必跌/ },
];

/**
 * 检查用户问题
 * @returns {{flagged:boolean, categories:string[], reframed:string|null, notice:string|null}}
 */
export function checkQuestion(q = '') {
  const text = String(q).trim();
  const categories = INPUT_RULES.filter((r) => r.re.test(text)).map((r) => r.cat);
  if (!categories.length) return { flagged: false, categories, reframed: null, notice: null };
  return {
    flagged: true,
    categories,
    reframed: '当前市场处于什么状态？主要矛盾是什么？哪些可观测条件出现时，这个判断需要改变？',
    notice: `你的问题涉及「${categories.join('、')}」。本产品不预测涨跌、不给买卖或仓位建议；已改为研判：当前状态、主要矛盾，以及什么条件会改变判断。`,
  };
}

// 输出侧：带「确定性/指令性」语气的涨跌与交易表述
const OUTPUT_RULES = [
  /(将|会|必将|必然|一定|肯定|势必|有望|大概率|预计|料将|即将)(继续)?(大幅|持续|快速|明显)?(上涨|下跌|反弹|回调|走高|走低|突破|见底|见顶|企稳|回升|下行|上行)/,
  /(建议|推荐|可以|应该|宜|不妨)(适当|逢低|逢高|积极|谨慎)?(买入|卖出|加仓|减仓|建仓|清仓|持有|配置|布局|低吸|追高|抄底|止损)/,
  /(仓位|满仓|空仓|半仓|轻仓|重仓)/,
  /(目标价|目标点位|看到\s*\d{3,5}\s*点)/,
  /(稳赚|保本|翻倍|确定性收益|无风险)/,
  /(抄底|逃顶)/,
];

/** 拦截违规句子，返回 { text, violations[] } */
export function sanitize(text = '') {
  const violations = [];
  const sentences = String(text).split(/(?<=[。；！？!?;])/);
  const out = sentences.map((s) => {
    const hit = OUTPUT_RULES.find((re) => re.test(s));
    if (!hit) return s;
    violations.push({ sentence: s.trim(), rule: hit.source });
    return '〔已拦截：该句涉及涨跌预测或投资建议〕';
  });
  return { text: out.join(''), violations };
}

export const DISCLAIMER = '本页内容由公开行情数据与确定性规则生成，用于理解市场状态，不构成任何投资建议；不预测涨跌，不提供买卖或仓位建议。';
