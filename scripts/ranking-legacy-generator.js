const fs = require('fs');

const sourcePath = process.argv[2];

if (!sourcePath) {
  console.error('用法: node scripts/ranking-legacy-generator.js <ranking-v2.json>');
  process.exit(1);
}

const ranking = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

if (!ranking || !Array.isArray(ranking.overall)) {
  console.error('新版排名数据缺少 overall 数组');
  process.exit(1);
}

process.stdout.write(JSON.stringify(ranking.overall, null, 2));
