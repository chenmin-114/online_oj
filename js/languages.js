/**
 * 支持的编程语言定义
 * Judge0 CE 语言 ID: https://ce.judge0.com/languages
 */
window.LANGUAGES = [
  {
    id: 'c',
    name: 'C',
    judge0LanguageId: 103, // GCC 14.1.0
    monacoLang: 'c',
    template: `#include <stdio.h>

int main() {
    // 在此编写你的代码
    
    return 0;
}
`,
  },
  {
    id: 'cpp',
    name: 'C++',
    judge0LanguageId: 105, // GCC 14.1.0
    monacoLang: 'cpp',
    template: `#include <iostream>
using namespace std;

int main() {
    // 在此编写你的代码
    
    return 0;
}
`,
  },
  {
    id: 'python',
    name: 'Python 3',
    judge0LanguageId: 92, // Python 3.11.2
    monacoLang: 'python',
    template: `# 在此编写你的代码
`,
  },
  {
    id: 'java',
    name: 'Java',
    judge0LanguageId: 91, // JDK 17.0.6
    monacoLang: 'java',
    template: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        // 在此编写你的代码
        
    }
}
`,
  },
  {
    id: 'javascript',
    name: 'JavaScript',
    judge0LanguageId: 93, // Node.js 18.15.0
    monacoLang: 'javascript',
    template: `const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

const lines = [];
rl.on('line', (line) => lines.push(line))
  .on('close', () => {
    // 在此编写你的代码
    // lines 数组包含所有输入行
    
  });
`,
  },
  {
    id: 'go',
    name: 'Go',
    judge0LanguageId: 106, // Go 1.22.0
    monacoLang: 'go',
    template: `package main

import "fmt"

func main() {
    // 在此编写你的代码
    fmt.Println("Hello")
}
`,
  },
  {
    id: 'rust',
    name: 'Rust',
    judge0LanguageId: 108, // Rust 1.85.0
    monacoLang: 'rust',
    template: `use std::io;

fn main() {
    // 在此编写你的代码
    
}
`,
  },
];

/**
 * 根据 id 获取语言定义
 */
function getLanguageById(id) {
  return window.LANGUAGES.find(lang => lang.id === id) || window.LANGUAGES[0];
}
