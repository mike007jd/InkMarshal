import { makeNovel, type ExampleNovel } from './types';
import { EXAMPLE_NOVEL_ID_PREFIX } from './prefix';

const slug = 'spark-from-the-forge';
const id = `${EXAMPLE_NOVEL_ID_PREFIX}${slug}`;

export const SPARK_FROM_THE_FORGE: ExampleNovel = {
  slug,
  pitch: 'A blacksmith with a forbidden gift discovers her hammer can rewrite memories.',
  stageBlurb: 'Brainstorming · the premise is taking shape.',
  novel: makeNovel({
    id,
    title: 'A Spark from the Forge',
    genre: 'Fantasy · Historical',
    stage: 'discovery_interview',
    progress: 5,
    storySummary:
      'In a kingdom where memory is a state-controlled resource, a young blacksmith discovers that her hammer can rework what people remember. She has to choose whether to use her gift to undo a war crime — at the cost of becoming the regime\'s most wanted heretic.',
    characterSummary:
      'Mira Vance, 24, blacksmith and bastard daughter of an exiled archivist. Practical, taciturn, allergic to grand causes — until one finds her.',
    arcSummary:
      'Discovery → conscience → first reluctant act → exposure → fugitive run → choosing a side.',
  }),
  chapters: [],
  conversation: [
    {
      role: 'assistant',
      content:
        "Hi, I'm your producer. Tell me about the spark — what's the one image or idea you can't stop thinking about for this book?",
    },
    {
      role: 'user',
      content:
        "A blacksmith hammering on a piece of metal — and every time she strikes it, someone in the village forgets a memory. She doesn't know it yet.",
    },
    {
      role: 'assistant',
      content:
        "That's a striking opening image — the violence of the smithy mapped onto something invisible. Two follow-ups before we go further:\n\n1. Is the memory loss random, or directed? (e.g. she shapes a horseshoe and a specific person forgets a specific thing)\n2. What world is this happening in? Modern? Historical? A specific historical period gives the reader a strong frame for free.",
    },
    {
      role: 'user',
      content:
        "Directed — but she doesn't realize it. She's doing repair work commissioned by the regime, and they know exactly what she is. Setting is something like late-medieval Iberia.",
    },
    {
      role: 'assistant',
      content:
        "Now we have a thriller, not just a fantasy. The regime as her unwitting employer is delicious — every commission is a little piece of state-sanctioned forgetting.\n\nWho first tells her the truth? The answer to that defines your inciting incident. Three quick directions:\n\n• A defector from the regime confesses on her doorstep.\n• A subject of one of her past 'jobs' tracks her down asking what she took from them.\n• She accidentally hammers something that affects HER — and she remembers something she shouldn't.\n\nWhich pulls you?",
    },
    {
      role: 'user',
      content:
        "Door 3. She's working on her own knife and remembers her mother dying — except her mother is supposed to be alive in the next village.",
    },
    {
      role: 'assistant',
      content:
        "Beautiful. That's your Page One. Let me draft the full premise back to you and we can move toward outline:\n\n> Mira Vance forges metal for a regime that has quietly used her gift for years. When she repairs her own knife and recovers a memory of her mother's death — a death the state insists never happened — she has to decide whether to find out what else has been taken from her, knowing every answer paints a target on her back.\n\nDoes that capture what you want? If yes, we can move to the outline stage and start sketching the chapter map.",
    },
  ],
  characters: [
    {
      name: 'Mira Vance',
      role: 'Protagonist · blacksmith',
      description:
        'Twenty-four, broad-shouldered, scarred forearms, a face people instinctively trust. Trained by her exiled archivist father in two trades: ironwork and silence. Practical to a fault — her loyalty is to the work in front of her, until the work starts costing other people their lives.',
    },
    {
      name: 'Inquisitor Rosa Estaire',
      role: 'Antagonist · regime liaison',
      description:
        'The Crown\'s memory-officer in Mira\'s province. Forty, devout, and a true believer that controlled forgetting is mercy. She has commissioned Mira twice already without telling her what those jobs really did.',
    },
  ],
  worldNotes: [
    'Memory is a state resource: the Crown keeps an Archive of "approved" history and excises the rest through licensed practitioners.',
    'Mira\'s gift is a recessive trait the regime has been quietly mapping for two generations; her father was the last to be conscripted before he disappeared.',
    'The setting is late-medieval Iberia in tone — peninsular geography, Inquisition-era surveillance, but the church is replaced by the Memory Office.',
  ],
};
