import { CHECK_CHARSET } from "./constants.js";
import { PlotCodeError } from "./error.js";

/**
 * 校验位算法：模 36 加权。
 *
 * 字符集为 0 到 9 与 A 到 Z 共 36 个字符，输出恒为单个字符。
 * 算法可复现、无外部依赖，便于在数据库约束与服务侧同时实现一份。
 *
 * 计算过程：
 * 1. 取编码前五段的字符序列，不含分隔符与校验位本身；
 * 2. 权重从右向左循环取 2、3、4、5、6、7，每位字符的取值为其在字符集中的下标；
 * 3. 计算加权和并对 36 取模，得到余数；
 * 4. 校验字符取字符集中下标为 (36 减余数) 再对 36 取模的那一位。
 */

/** 权重循环序列 */
const WEIGHTS = [2, 3, 4, 5, 6, 7] as const;

/**
 * 计算校验位。
 * @param body 前五段拼接后的字符序列，不含分隔符与校验位
 * @returns 单个校验字符，取值属于 CHECK_CHARSET
 */
export function computeCheckChar(body: string): string {
  if (body.length === 0) {
    throw new PlotCodeError("校验位计算需要非空的字符序列");
  }

  let sum = 0;
  let weightIndex = 0;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const value = CHECK_CHARSET.indexOf(body.charAt(i));
    if (value < 0) {
      throw new PlotCodeError(`字符 ${body.charAt(i)} 不在校验字符集内`);
    }
    const weight = WEIGHTS[weightIndex % WEIGHTS.length] ?? 2;
    sum += value * weight;
    weightIndex += 1;
  }

  return CHECK_CHARSET.charAt((36 - (sum % 36)) % 36);
}
