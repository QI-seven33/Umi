/**
 * 把模型输出的 LaTeX 公式转换为更适合展示的形式。
 *
 * 针对轻量/终端场景的优化：
 * 1. 块级公式 \[...\] → $$...$$，交给 KaTeX 渲染（块级下通常不会出现上下标裁切）。
 * 2. 行内公式 \(...\) 和 $...$ → Unicode 纯文本，从源头杜绝 KaTeX 行内上下标被压扁的问题。
 * 3. 代码块用占位符保护，避免误伤代码里的 \[ \( $。
 */
export function preprocessMath(content: string): string {
  if (!content) return content;

  // 1. 抠出代码块
  const codeBlocks: string[] = [];
  let masked = content.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  // 2. 块级公式 \[...\] → $$ 独占一行
  masked = masked.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_, math) => `\n\n$$\n${String(math).trim()}\n$$\n\n`
  );

  // 3. 行内公式 \(...\) → 占位符
  masked = masked.replace(
    /\\\(([\s\S]*?)\\\)/g,
    (_, math) => `\u0000MATHINLINE${String(math).trim()}\u0000`
  );

  // 4. 行内公式 $...$ → 占位符（避免匹配 $$ 内的 $）
  masked = masked.replace(
    /(?<!\$)\$(?!\$)([^\$\n]+?)(?<!\$)\$(?!\$)/g,
    (_, math) => `\u0000MATHINLINE${String(math).trim()}\u0000`
  );

  // 5. 行内公式占位符 → Unicode 纯文本
  masked = masked.replace(
    /\u0000MATHINLINE([\s\S]*?)\u0000/g,
    (_, math) => latexToUnicode(String(math))
  );

  // 6. 还原代码块
  masked = masked.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);

  return masked;
}

/**
 * 将 LaTeX 片段转换成 Unicode 纯文本。
 * 覆盖常见的：上下标、希腊字母、运算符、箭头、根号、集合符号等。
 */
function latexToUnicode(latex: string): string {
  // 常见 LaTeX 命令 → Unicode
  const commandMap: Array<[RegExp, string]> = [
    // 希腊字母
    [/\\alpha\b/g, "α"], [/\\beta\b/g, "β"], [/\\gamma\b/g, "γ"], [/\\delta\b/g, "δ"],
    [/\\epsilon\b/g, "ε"], [/\\varepsilon\b/g, "ε"], [/\\zeta\b/g, "ζ"], [/\\eta\b/g, "η"],
    [/\\theta\b/g, "θ"], [/\\vartheta\b/g, "ϑ"], [/\\iota\b/g, "ι"], [/\\kappa\b/g, "κ"],
    [/\\lambda\b/g, "λ"], [/\\mu\b/g, "μ"], [/\\nu\b/g, "ν"], [/\\xi\b/g, "ξ"],
    [/\\pi\b/g, "π"], [/\\rho\b/g, "ρ"], [/\\sigma\b/g, "σ"], [/\\tau\b/g, "τ"],
    [/\\upsilon\b/g, "υ"], [/\\phi\b/g, "φ"], [/\\varphi\b/g, "φ"], [/\\chi\b/g, "χ"],
    [/\\psi\b/g, "ψ"], [/\\omega\b/g, "ω"],
    [/\\Gamma\b/g, "Γ"], [/\\Delta\b/g, "Δ"], [/\\Theta\b/g, "Θ"], [/\\Lambda\b/g, "Λ"],
    [/\\Xi\b/g, "Ξ"], [/\\Pi\b/g, "Π"], [/\\Sigma\b/g, "Σ"], [/\\Phi\b/g, "Φ"],
    [/\\Psi\b/g, "Ψ"], [/\\Omega\b/g, "Ω"],
    // 运算符
    [/\\le\b/g, "≤"], [/\\leq\b/g, "≤"], [/\\ge\b/g, "≥"], [/\\geq\b/g, "≥"],
    [/\\ne\b/g, "≠"], [/\\neq\b/g, "≠"], [/\\approx\b/g, "≈"], [/\\equiv\b/g, "≡"],
    [/\\times\b/g, "×"], [/\\div\b/g, "÷"], [/\\cdot\b/g, "·"], [/\\pm\b/g, "±"],
    [/\\mp\b/g, "∓"], [/\\ast\b/g, "∗"], [/\\star\b/g, "⋆"], [/\\circ\b/g, "∘"],
    // 集合与逻辑
    [/\\in\b/g, "∈"], [/\\notin\b/g, "∉"], [/\\subset\b/g, "⊂"], [/\\supset\b/g, "⊃"],
    [/\\subseteq\b/g, "⊆"], [/\\supseteq\b/g, "⊇"], [/\\cup\b/g, "∪"], [/\\cap\b/g, "∩"],
    [/\\emptyset\b/g, "∅"], [/\\varnothing\b/g, "∅"],
    [/\\forall\b/g, "∀"], [/\\exists\b/g, "∃"], [/\\nexists\b/g, "∄"],
    [/\\neg\b/g, "¬"], [/\\land\b/g, "∧"], [/\\lor\b/g, "∨"],
    // 箭头
    [/\\to\b/g, "→"], [/\\rightarrow\b/g, "→"], [/\\leftarrow\b/g, "←"],
    [/\\Rightarrow\b/g, "⇒"], [/\\Leftarrow\b/g, "⇐"], [/\\leftrightarrow\b/g, "↔"],
    [/\\Leftrightarrow\b/g, "⇔"], [/\\mapsto\b/g, "↦"],
    // 其它
    [/\\infty\b/g, "∞"], [/\\nabla\b/g, "∇"], [/\\partial\b/g, "∂"],
    [/\\cdots\b/g, "⋯"], [/\\ldots\b/g, "…"], [/\\dots\b/g, "…"],
    [/\\quad\b/g, " "], [/\\qquad\b/g, "  "],
    [/\\,/g, " "], [/\\;/g, " "], [/\\!/g, ""],
  ];

  let result = latex;

  // 先处理 \text{...} 和 \mathrm{...} 等：只保留内部文字
  result = result.replace(/\\(?:text|mathrm|mathbf|mathit|mathbb|mathcal)\{([^{}]*)\}/g, "$1");

  // 处理 \sqrt[n]{x} 和 \sqrt{x}
  result = result.replace(/\\sqrt\[([^\]]+)\]\{([^{}]*)\}/g, (_, n, x) => `${x}^(${n})`);
  result = result.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");

  // 处理 \frac{a}{b} → (a)/(b)
  result = result.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");

  // 常见命令替换
  for (const [re, unicode] of commandMap) {
    result = result.replace(re, unicode);
  }

  // 上下标：^n → 上标字符；_n → 下标字符
  const superscripts: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "n": "ⁿ", "i": "ⁱ",
  };
  const subscripts: Record<string, string> = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    "a": "ₐ", "e": "ₑ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ",
    "n": "ₙ", "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ",
    "u": "ᵤ", "v": "ᵥ", "x": "ₓ",
  };

  // 先处理 ^{...} 和 _{...}
  result = result.replace(/\^\{([^{}]*)\}/g, (_, inner) => toScript(inner, superscripts));
  result = result.replace(/_\{([^{}]*)\}/g, (_, inner) => toScript(inner, subscripts));

  // 再处理 ^x 和 _x（单字符）
  result = result.replace(/\^([0-9a-zA-Z+\-=()])/g, (_, c) => superscripts[c] ?? `^${c}`);
  result = result.replace(/_([0-9a-zA-Z+\-=()])/g, (_, c) => subscripts[c] ?? `_${c}`);

  // 去掉 LaTeX 花括号
  result = result.replace(/[{}]/g, "");

  // 去掉多余空格
  result = result.replace(/\s+/g, " ").trim();

  return result;
}

function toScript(text: string, map: Record<string, string>): string {
  // 全部可映射，则整体转
  if ([...text].every((ch) => map[ch] !== undefined)) {
    return [...text].map((ch) => map[ch]).join("");
  }
  // 否则退化为 ^{...} 形式
  return text;
}
