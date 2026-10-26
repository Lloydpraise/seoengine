const src = require('./work/source.json');
const [from, to] = process.argv.slice(2).map(Number);
src.slice(from, to).forEach((p, i) => {
  const f = p.final, s0 = f.sections[0];
  console.log(`\n##### [${from + i}] ${p.id} | ${p.name} | ${p.major_category}/${p.sub_category}`);
  console.log(`KW: ${f.primary_keyword} || ${f.secondary_keywords.join(' ; ')}`);
  console.log('META:', f.meta_description); console.log('SHORT:', f.short_description);
  console.log(`[${s0.heading}] ${s0.body.replace(/\n+/g, ' / ')}`);
  console.log('SPECS:', f.specs.map((x) => x.label + '=' + x.value).join('; '));
  console.log('OTHER:', f.sections.slice(1).map((x) => x.heading).join(' | '), '|| FAQ:', f.faqs.map((x) => x.q).join(' | '));
});
