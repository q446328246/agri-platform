import { describe, expect, it } from "vitest";
import { buildCsv } from "../src/utils/export.js";

describe("CSV 转义", () => {
  it("常规字段直接拼接，空值留空而非写出 null", () => {
    expect(buildCsv(["编码", "作物"], [["A-1", "水稻"], ["A-2", null]])).toBe("编码,作物\r\nA-1,水稻\r\nA-2,");
  });

  it("含逗号、引号或换行的字段整体加引号，内部引号翻倍", () => {
    expect(buildCsv(["名称"], [['东区三号田,大棚"1"号']])).toBe('名称\r\n"东区三号田,大棚""1""号"');
    expect(buildCsv(["备注"], [["第一行\n第二行"]])).toBe('备注\r\n"第一行\n第二行"');
  });

  it("以公式字符开头的文本前置单引号，避免电子表格执行", () => {
    expect(buildCsv(["名称"], [['=HYPERLINK("http://evil")']])).toBe(`名称\r\n"\'=HYPERLINK(""http://evil"")"`);
    expect(buildCsv(["名称"], [["+86 13900000000"], ["-斜坡地块"], ["@张三"], ["\t制表符开头"]])).toBe(
      "名称\r\n'+86 13900000000\r\n'-斜坡地块\r\n'@张三\r\n'\t制表符开头"
    );
  });

  it("数字与布尔值不做公式防护，负数保持原值", () => {
    expect(buildCsv(["面积", "启用"], [[-3.5, true], [31.4, false]])).toBe("面积,启用\r\n-3.5,true\r\n31.4,false");
  });
});
