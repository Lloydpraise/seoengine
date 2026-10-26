// Corrections after checking each product photo (22 Oct 2026). Applied by build.js after the sales rewrite.
const setSection = (d, heading, body) => { const s = d.sections.find((x) => x.heading === heading); if (!s) throw new Error(`${d.id}: no section "${heading}"`); s.body = body; };
const setFaq = (d, q, a) => { const f = d.faqs.find((x) => x.q === q); if (!f) throw new Error(`${d.id}: no FAQ "${q}"`); f.a = a; };
const dropFaq = (d, q) => { const n = d.faqs.length; d.faqs = d.faqs.filter((x) => x.q !== q); if (d.faqs.length === n) throw new Error(`${d.id}: no FAQ "${q}"`); };

module.exports = {
  // Photo: stainless steel cabinet oven with 6 flat trays, side door, 2 knobs and a light, caster wheels, power cable at the back. No rotisserie, no burners.
  6: (d) => {
    d.name = 'Commercial Stainless Steel Oven with 6 Trays';
    d.photo_check = 'Photo shows a stainless steel cabinet oven with 6 flat trays, a side-hinged door, 2 knobs and an indicator light, caster wheels and a power cable at the back. No rotisserie rods, spits or burners, so the old name "Commercial Gas Chicken Rotisserie Oven" was wrong and has been changed. Slug kept so the link does not change.';
    d.specs.push({ label: 'Power', value: 'Electric (power cable fitted)' });
    setSection(d, 'What to Check Before Buying', 'Check your electrical supply before you buy. The unit shown is fitted with a power cable, so plan a suitable socket close to where it will stand, and ask us for the exact power rating.\n\nAllow enough floor space for the cabinet and for the door to open fully, with room around it for ventilation.\n\nMatch the six tray capacity to the volume you bake or keep warm at your busiest time.');
    setFaq(d, 'Is the oven powered by gas or electricity?', 'The unit shown is electric and comes with a power cable. Ask our team for the exact power rating so we can confirm it suits your supply.');
    setFaq(d, 'Does this oven have rotisserie rods for chicken roasting?', 'No. It is a multi-tray oven with six flat trays, for baking and keeping food warm. Ask us if you need a rotisserie and we will show you our chicken rotisserie ovens.');
    d.owner_questions = ['Confirm this is electric and give the power rating (kW, single or three phase).', 'Is it a baking oven or a warming cabinet (what temperature does it reach)?'];
  },
  // Photo: one large multi-ring burner on a black square steel frame, 3 brass valves on the side. A single big-pot burner, not a 4-plate stove.
  84: (d) => {
    d.name = 'Single Burner Gas Stove with Multi-Ring Burner';
    d.photo_check = 'Photo shows one large multi-ring gas burner on a black square steel frame, with 3 brass valves on the side. It is a single big-pot burner, so the old name "4 ring gas stove" was misleading and has been changed. Slug kept so the link does not change.';
    d.alt_text = 'Single burner gas stove with a large multi-ring burner lit, black steel frame and brass gas valves on the side';
    d.specs = d.specs.map((s) => (s.label === 'Frame Material' ? { label: 'Frame Material', value: 'Black painted steel' } : s.label === 'Number of Burners' ? { label: 'Number of Burners', value: '1 large multi-ring burner' } : s));
    setFaq(d, 'How many burners does this stove have?', 'One large burner with several flame rings, each controlled by its own brass valve. Light one ring to simmer or all of them for full heat under a big sufuria.');
    d.owner_questions = ['How many flame rings does the burner have (the photo shows 3 valves, the old name said 4)?', 'High pressure or low pressure gas?'];
  },
  // Photo: stainless steel range with 6 gas-style burners with pot supports and 6 brass knobs, over an oven with a digital control panel. No induction surface.
  137: (d) => {
    d.name = '6 Burner Freestanding Commercial Cooker with Baking Oven';
    d.photo_check = 'Photo shows a stainless steel range with 6 open burners with pot supports and 6 brass knobs, over a baking oven with a digital control panel. There is no induction glass top, so "Induction" and the induction model number LT-B290VI-JL were removed from the name, and specs copied from that induction model (8-gear knob, IPX6, size, warranty) were removed. Slug kept so the link does not change.';
    d.alt_text = 'Stainless steel 6 burner freestanding commercial cooker with brass control knobs and a baking oven with digital control panel below';
    d.specs = [
      { label: 'Burners', value: '6 burners with pot supports' },
      { label: 'Controls', value: '6 brass burner knobs; digital control panel for the oven' },
      { label: 'Oven', value: 'Built-in baking oven with pull-down door' },
      { label: 'Material', value: 'Stainless steel' },
      { label: 'Design', value: 'Freestanding' },
    ];
    setSection(d, 'What to Check Before Buying', 'Plan the gas supply for the six burners and a power point for the oven\'s digital control panel, and ask us to confirm the exact requirements for your kitchen. Measure your space so there is room to open the oven door fully and to work safely at the burners, with a hood above for smoke and heat.');
    const zones = d.faqs.find((x) => x.q === 'How many cooking zones are available?');
    zones.q = 'How many burners does it have?';
    zones.a = 'Six burners on top, so your chefs can cook six dishes at once, plus a baking oven underneath.';
    setFaq(d, 'What power supply does this cooktop require?', 'The burners run on gas and the oven has a digital control panel. Tell us your kitchen setup and our team will confirm the gas and power connections before delivery.');
    dropFaq(d, 'Is a warranty included with this appliance?');
    d.owner_questions = ['Confirm the burners are gas (the photo shows open burners with pot supports, not induction).', 'Is the oven gas or electric, and what are the cooker\'s dimensions?', 'Any warranty to state?'];
  },
  // Photo: black mild steel frame with 6 burners, brass valves and copper pipes. The specs named a competitor as the brand.
  73: (d) => {
    d.specs = d.specs.filter((s) => !['Brand', 'Warranty'].includes(s.label));
    d.photo_check = 'Removed the competitor brand ("Shine Kitchenware Kenya") and its manufacturer warranty from the specs. Photo shows a black steel frame with 6 burners, brass valves and copper gas pipes.';
    d.owner_questions = ['Any warranty to state for this cooker?'];
  },
};
