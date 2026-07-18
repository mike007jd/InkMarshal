import { makeChapter, makeNovel, type ExampleNovel } from './types';
import { EXAMPLE_NOVEL_ID_PREFIX } from './prefix';

const slug = 'cartographers-daughter';
const id = `${EXAMPLE_NOVEL_ID_PREFIX}${slug}`;

const blueprintChapters = [
  { num: 1,  title: 'The False Map',          summary: 'Ines forges a map of a valley that does not exist; the Crown\'s expedition departs in the morning.' },
  { num: 2,  title: 'Forty Soldiers',         summary: 'On the road, Ines meets the prince and the cartographers she has effectively sentenced to death.' },
  { num: 3,  title: 'Wrongturn at Saltgate',  summary: 'A scholar notices her error; she silences him with a half-truth that costs her a friendship.' },
  { num: 4,  title: 'The Thornwall',          summary: 'The expedition reaches the impossible valley. The first man dies of cold, blaming his compass.' },
  { num: 5,  title: 'A Letter Home',          summary: 'Ines finds a courier and tries to send a warning home. The courier is a Crown spy.' },
  { num: 6,  title: 'The Final Stand',        summary: 'Cornered, she destroys the original survey notes — buying the survivors time, or just hiding her own crime.' },
  { num: 7,  title: 'Return to a Quiet City', summary: 'Three weeks later, Ines walks back into the capital alone. Nobody asks the right questions.' },
  { num: 8,  title: 'The Inquiry',            summary: 'A magistrate begins to compare her old maps. He is patient, and he is family.' },
  { num: 9,  title: 'Confession to a Stone',  summary: 'Ines visits her dead father\'s grave. He taught her to lie with maps.' },
  { num: 10, title: 'A Map for Burning',      summary: 'The crown commissions another expedition. This time the false map is not hers.' },
  { num: 11, title: 'Two Cartographers',      summary: 'Ines meets her father\'s former apprentice — the only other person who knows what the Crown does with bad maps.' },
  { num: 12, title: 'True North',             summary: 'A confession; an offer; a choice. Ines decides what kind of mapmaker she is willing to be.' },
];

export const CARTOGRAPHERS_DAUGHTER: ExampleNovel = {
  slug,
  pitch: 'A royal mapmaker forges a valley, then the king sends an expedition.',
  stageBlurb: 'Outline approved · drafting Chapter 1.',
  novel: makeNovel({
    id,
    title: "The Cartographer's Daughter",
    genre: 'Historical · Political Thriller',
    stage: 'ready_for_greenlight',
    progress: 25,
    storySummary:
      "Ines de Salvar is the king's most trusted cartographer. When the Crown begins commissioning surveys of disputed land, she falsifies one map to bury a family secret — and watches the resulting expedition march into a valley that doesn't exist. The book follows her over twelve chapters as the consequences ripple back through the court, the church, and finally her own father's grave.",
    characterSummary:
      'Ines de Salvar (32, royal cartographer, bastard daughter of a famous explorer) and Crown Prince Alaric, who leads the doomed expedition.',
    arcSummary:
      'Forgery → expedition → discovery → cover-up → personal reckoning → legacy choice.',
  }),
  blueprint: {
    chapters: blueprintChapters.map(c => ({ chapterNumber: c.num, title: c.title, summary: c.summary })),
    targetWordsPerChapter: 6500,
    generatedAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    modelId: 'demo-blueprint',
  },
  chapters: [
    makeChapter({
      novelId: id,
      chapterNumber: 1,
      title: 'The False Map',
      content: `The candle on Ines's worktable had burned down to a stub when she set the final ink line. It curved south of the Thornwall Peaks, a wide elegant arc that ended in a valley that did not exist.

She blew on the parchment, more out of habit than any need to dry it. The ink had been dry for an hour. She had been sitting with the finished map, looking at the new river she had given the world, the way one might sit with a body before calling for the priest.

Outside the workshop, the city was quiet in the way only the deepest hour was quiet — the night-soil carts already gone, the bell-ringers not yet awake, even the dogs giving up on whatever quarrel had kept them busy until midnight. Through the small window above the bench she could see the moon riding low over the warehouse roofs, the tile glazed silver where the rain had not yet evaporated.

Her father had taught her to do this work in exactly such a silence. "A cartographer," he liked to say, "is a man who decides what is true." He had said it with a smile that, looking back now, she suspected had not been a smile at all.

She rolled the map carefully, banded it with the green ribbon the Crown's couriers expected, and pressed her seal into the wax. The wax was the colour of dried blood, which was the colour the Royal Office issued to its senior surveyors. She had carried the seal for nine years. She had never once forged with it. Until tonight.

The expedition would leave at dawn. Forty soldiers, twelve scholars, the Crown Prince himself — he had insisted on going, as if the Thornwall valley were already part of his future kingdom and not just a line she had drawn three hours ago in a grief-soaked hand. They would take her map. They would follow her river. They would arrive, eventually, at a place that simply was not there.

She set the rolled map at the centre of the worktable and stood looking at it. From a distance it was indistinguishable from the dozens of honest maps that had passed across this same bench. The same hand. The same ink. The same green ribbon.

But tonight, standing in the archives with ink still wet on her fingers, she understood the cost. The expedition to the Thornwall Peaks — forty soldiers, twelve scholars, the Crown Prince himself — had followed her map into a valley that did not exist. The search parties would find nothing. She had made sure of that, too.

She put out the candle. She did not pray. The map sat in the dark, and she sat with it, and outside the city went on being unaware that it was already a different city than it had been the night before.`,
    }),
  ],
  conversation: [
    {
      role: 'assistant',
      content:
        "I've drafted a 12-chapter blueprint based on our brainstorm. The arc traces Ines's forgery through to her final reckoning. Ready to review?",
    },
    {
      role: 'user',
      content:
        'Yes, walk me through the structure.',
    },
    {
      role: 'assistant',
      content:
        "Three acts. Act I (chapters 1–4) is the crime: forgery, expedition, the first death. Act II (chapters 5–8) is the cover-up: her warning is intercepted, she returns to the city, the magistrate begins his quiet inquiry. Act III (chapters 9–12) is the reckoning: confession at her father's grave, the second false map, and the choice she makes when she meets her father's former apprentice.\n\nThe twelve chapter titles and one-line summaries are in the outline panel. Do you want to edit any of them before I lock the blueprint and start writing?",
    },
    {
      role: 'user',
      content:
        'Looks tight. Lock the blueprint and let\'s draft Chapter 1.',
    },
    {
      role: 'assistant',
      content:
        "Blueprint locked. Drafting Chapter 1 — \"The False Map\" — at ~6,500 words. I'll show you the first scene as it streams.",
    },
  ],
  characters: [
    {
      name: 'Ines de Salvar',
      role: 'Protagonist · royal cartographer',
      description:
        'Thirty-two, careful, sleeps badly. Has carried the senior cartographer\'s seal for nine years and has never abused it — until the night before this story begins. Her father was the explorer Don Eladio de Salvar; she has spent her career trying to be the kind of mapmaker he was famous for being and is only now realizing that may have been a lie.',
    },
    {
      name: 'Crown Prince Alaric',
      role: 'Doomed traveler',
      description:
        'Twenty-six, idealistic, allergic to the court\'s caution. He has insisted on personally leading the Thornwall expedition because he believes the valley will be his first quiet act of kingship. He likes Ines. He trusts her work.',
    },
    {
      name: 'Magistrate Tomás Reyes',
      role: 'Investigator · estranged uncle',
      description:
        'Sixty, patient, almost gentle. The state\'s slowest and most thorough magistrate. He is also Ines\'s mother\'s younger brother — a fact neither of them has spoken about for years.',
    },
  ],
  worldNotes: [
    'Cartographers in the kingdom hold a state monopoly: only sealed Royal Office maps are admissible in court, in war, or in trade.',
    'The Thornwall Peaks are a real disputed border range; the "valley" Ines invented is plausible enough that no one will question it for at least three weeks of marching.',
    'Forging a Crown map is treason. The penalty is the rope. Ines has done this anyway.',
  ],
};
