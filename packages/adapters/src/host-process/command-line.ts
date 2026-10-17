// Windows C 运行库 argv 编码；调用者须另外验证程序及参数，CMD 使用独立语义。
export function quoteArgument(value: string) {
  if (value && !/[\s"]/.test(value)) return value;
  return (
    '"' +
    value
      .replace(/(\\*)"/g, (_m, slashes: string) => slashes + slashes + '\\"')
      .replace(/\\+$/g, (s) => s + s) +
    '"'
  );
}
