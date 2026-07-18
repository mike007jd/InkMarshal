import { makeChapter, makeNovel, type ExampleNovel } from './types';
import { EXAMPLE_NOVEL_ID_PREFIX } from './prefix';

const slug = 'salt-and-hollow';
const id = `${EXAMPLE_NOVEL_ID_PREFIX}${slug}`;

const blueprintChapters = [
  { num: 1,  title: 'The Tide That Returns Things',          summary: 'The lighthouse-keeper\'s daughter pulls a body from the rocks. She knows him — and he has been dead for eight years.' },
  { num: 2,  title: 'A Town That Forgets in Tides',          summary: 'Hollow Cove\'s elders refuse to look at the body. The sea has done this before; they have rules.' },
  { num: 3,  title: 'The Man Who Should Not Be Wet',         summary: 'Sera tries to warm the corpse. It opens its eyes. It asks her, in her father\'s voice, to take it home.' },
  { num: 4,  title: 'Salt in the Lamp Oil',                  summary: 'The light in the lighthouse begins to dim. Sera discovers the oil has gone briny — the sea is reaching inland.' },
  { num: 5,  title: 'Counting the Returned',                  summary: 'Sera makes a list of the cove\'s missing dead. Half the names are people the elders pretend never existed.' },
  { num: 6,  title: 'The Final Stand',                       summary: 'Sera confronts the head of the elder council. He shows her the cellar. She finally understands what the town has been doing.' },
  { num: 7,  title: 'The Bargain',                            summary: 'The dead are willing to leave — but they want something only Sera can give them.' },
  { num: 8,  title: 'Sister of the Salt',                     summary: 'Sera\'s younger sister returns from the rocks. She has been missing since they were children.' },
  { num: 9,  title: 'A Light That Will Not Hold',              summary: 'The lighthouse begins to fail. The town wants Sera to choose: them or her sister.' },
  { num: 10, title: 'What the Sea Was Owed',                  summary: 'Sera unlocks the cellar in a single hour. The cove pays its debt at last.' },
  { num: 11, title: 'The Tide That Takes Things Back',        summary: 'Funerals, finally. Sera writes new names on the lighthouse wall.' },
  { num: 12, title: 'A New Keeper',                            summary: 'Sera leaves Hollow Cove and is given the next lighthouse north. The light does not dim.' },
];

const chapter1 = `The body came back at the turn of the tide, just as her father always said the worst things did.

Sera had been on the lighthouse stairs when she heard the bell — not the storm bell, but the small bronze one her grandmother had hung over the rocks for exactly this purpose, exactly this hour. She had not heard it ring in eight years. She had thought, in the casual way people think about old machinery, that it had rusted shut.

She came down the stairs three at a time, took the lantern from the hook, and went out into the wet grey morning without bothering with a coat.

The man was face-down in the gully where the tide always pushed things — driftwood, the occasional drowned gull, once, when she was twelve, the lid of a sea-chest that had taken three men to lift. He was wearing the brown wool jacket of the south-coast crews. His hands were swollen but his hair was clean. He had not been in the water long enough.

She did not know how she knew it was him until she rolled him over.

His face was older than she remembered, and softer in a way that the sea sometimes did to faces, as if it had been polishing him. But it was him. The small white scar above his lip from the time they had fought over a kite. The crooked tooth she had teased him about for an entire summer.

His name was Tobias Mar. He had been her brother. He had been dead since she was fifteen.

She knelt in the wet shingle and put her hand against his cheek and he was cold but not the cold of a dead thing — the cold of a thing that had been very far away for a very long time, and was only now coming back into the room.

She did not scream. Her father had taught her better than that.

She unhooked the small bronze bell from the rock, set it carefully into her pocket, and ran for the village.`;

const chapter2 = `The elders were already waiting in the chapel by the time Sera reached the green. She did not stop to wonder how they had known. She had been ringing a bell that nobody had heard in eight years; in Hollow Cove, this was its own kind of summons.

There were five of them. Old Carrick, who ran the boats. Mother Vyne, who ran everything else. The blacksmith, the harbour-master, and the schoolteacher who had taught Sera to read and had not aged a single day in fifteen years. They were sitting along the chapel's front bench in a row, like a panel of judges.

"Where," said Mother Vyne.

"South gully. The deep one."

"Wet?"

"Damp."

"Long?"

"He's whole."

There was a small silence. The blacksmith looked at his hands. The schoolteacher closed her eyes the way she closed them when a child read badly.

"You'll bring him to the cellar," said Mother Vyne. "Before noon. You won't speak of him to anyone else. You won't write his name anywhere."

"It's Tobias," said Sera.

"I know what it is," said Mother Vyne, very gently. "That's why you'll do as I tell you."

"He's my brother."

"He was. He isn't. There is a difference, and the cove cannot afford for you to confuse them."

Sera stood in the aisle of her grandmother's chapel and looked at five faces she had known her whole life, and understood, with a calm that she would later remember as the worst feeling of her life, that none of them were surprised.

She did not yet know what she was going to do. But she knew she was not bringing him to the cellar.`;

const chapter3 = `She brought him to the lighthouse instead.

It was not a long walk in good weather; with a body across her shoulders, in the rain, with the path slick from the night's storm, it took her until almost dusk. By the end she was crawling the last hundred yards, dragging him by the collar of the brown wool jacket, swearing at the gulls that were beginning to think about him.

She got him into the kitchen. She bolted the door. She lit the stove with shaking hands. She filled the great iron kettle and set it to boil and then sat on the stone floor next to him for a long time, watching the rain come in under the threshold.

He did not move. He did not breathe in any way she could see. He was a corpse and he was her brother and he was here and the elders had not been surprised.

She wrapped him in her father's old fleece blanket. She wrapped a second blanket over that. She set the kettle next to him on the floor for warmth — she did not know why; she only knew that when a thing was cold the answer was to make it warm. Her father had taught her this. Her father had also been the one who, on the night Tobias drowned, had walked into the sea up to his waist and walked back out alone.

She was beginning to wonder why.

She was reaching for a third blanket when his eyelids opened.

They opened slowly, without any of the wet-paper stickiness she had been bracing herself for. Underneath them his eyes were grey, the same grey they had always been, the grey of the cove on a still morning.

He looked at her for a long moment. He did not seem surprised either.

When he finally spoke, it was not in the sea-rough voice of a sixteen-year-old boy. It was in her father's voice, low and careful, and he said:

"Sera. Take me home."`;

const chapter4 = `She did not sleep.

She stayed in the kitchen with him until the storm broke and the first thin grey of dawn climbed the lighthouse stairs. He did not speak again. She had asked him three questions; he had not answered any of them. He had only kept his grey eyes on her, patient, the way you wait for a child to stop crying.

At first light she went up to check the lamp.

The lamp was wrong.

The flame was still burning — the great brass burner her grandfather had cast, the one that had not gone out in seventy years — but it was burning low, and it was burning blue, the colour of brine in a copper pot. She could smell it before she could see it: the sweet metallic smell of salt where there should have been only clean fish-oil.

She climbed up to the reservoir and dipped her finger in.

It was sea-water.

There were only two ways for sea-water to get into the lighthouse oil reservoir. The first was that someone had poured it in. The second was that the cove had decided to take its lighthouse back.

She stood on the iron platform with her finger in her mouth, tasting the salt, and looked out at the village in the grey dawn — at the chapel where Mother Vyne was probably still awake, at the cellar door behind the chapel that nobody was supposed to talk about, at the row of houses along the harbour where her childhood friends were still pretending to sleep.

The light had been her grandmother's. It had been her mother's. Now, briefly, it was hers.

If it went out, the cove would have an excuse to come for the keeper. They had needed an excuse for years. They would not need it for long.

She took her finger out of her mouth, came down the iron stairs, and went to her father's old map drawer to find a list of the cove's missing dead.`;

const chapter5 = `By midday she had thirty-one names.

Her father had kept a logbook. Every keeper of the lighthouse had kept a logbook, going back four generations, and Sera had inherited the lot. They were stacked in the small alcove off the kitchen — twenty-three leather-bound volumes, the oldest of them stitched together by her great-great-grandmother with sail-twine.

She was looking for missing persons. Anyone whose body the cove had failed to recover.

She found thirty-one names. By midafternoon she had cross-checked them against the Cove Register that hung in the chapel, the one that listed every soul born in Hollow Cove since the bell-tower was built. Of the thirty-one missing persons, sixteen had no entry in the register at all. They had simply been erased.

She sat at the kitchen table with her two lists and a third clean sheet of paper, and she began to write the sixteen names down again, in her own careful hand. Her father had taught her this hand: small, even, no flourishes. It was the hand he had used for everything from grocery lists to the entry, in the logbook for August of her fifteenth year, that read only Tobias and the date.

She had asked him, that night, why he had not written more. He had said: "Because there isn't more to write. He went out. He didn't come back. The cove will tell us what it wants us to know."

She understood now that he had not been being kind. He had been being literal.

The cove had told them, eventually, that Tobias was no longer a person they were allowed to remember. And the cove had told them by erasing his name from the register on the chapel wall, the morning after he drowned, in handwriting that none of them had recognized but none of them had questioned.

She was writing the sixteenth name when she heard the boots on the path.

It was Mother Vyne.

Sera folded the list once, then twice, and slid it under the loose stone by the kitchen hearth where her father had kept his money and her mother had kept her letters. Then she went to the door, smoothed her apron, and opened it.

"You did not bring him to the cellar," said Mother Vyne.

"No."

"Then you'll come to the cellar yourself. Tonight. After the lamp is lit."

She looked past Sera into the kitchen. She did not — Sera noticed — look at the bundle of blankets on the floor by the stove.

"Bring the list," she said.`;

const chapter6 = `The cellar was bigger than Sera had expected.

It was carved into the chalk under the chapel — a long low room with a vaulted roof and a packed-earth floor, lit by oil lamps that hung from iron hooks at intervals of about ten feet. The lamps burned blue. Of course they burned blue. The cove was reaching here too.

Mother Vyne went down the stairs first. The blacksmith brought up the rear, not unkindly, but close enough that Sera could feel the small heat of him at her back. They had not asked her to bring the bell. They had not had to. She had it in her pocket anyway, and she suspected that Mother Vyne knew.

At the far end of the cellar there was a door.

It was made of pale wood, the colour of driftwood that has been bleached for a long time, and it had three iron bolts across it: one at the top, one in the middle, one at the bottom. There was no lock. There were only the bolts. The bolts were on Sera's side.

"Open it," said Mother Vyne.

Sera did not move. "What's in it."

"You know what's in it."

"I want you to say it."

Mother Vyne sighed. It was the first time, Sera realized, that she had ever heard Mother Vyne sigh — a small human sound, weary, almost sad.

"What's in it," said Mother Vyne, "is the thing the cove agreed to keep so that the rest of us could go on living here. It used to be a hole in the chalk. Then it was a room. Now it is what you see. The bolts are on this side because the agreement is that we hold them. If we hold them, the sea takes only what we give it, and gives back only what we ask for."

"And if you don't hold them?"

"Then it takes what it wants. Including this village. Including you. Including the lighthouse, and your father's logbooks, and every other thing that has ever stood between the sea and our children."

Sera looked at the door for a long time.

"My brother is upstairs," she said. "Wrapped in my father's blanket. Waiting for me to take him home."

"Yes."

"And if I open this door."

"He goes back," said Mother Vyne. "Where he came from. With everything else we have been keeping in here."

Sera reached for the top bolt.

She did not pull it. Not yet. She only put her hand on it, to feel the cold of the iron against her palm, and to feel — for the first time in her life — exactly how much weight a single small piece of metal could carry.

The corridor stretched endlessly before her, each flickering light casting shadows that seemed to whisper secrets of the old world. Sera pressed her back against the cold stone and listened. Footsteps — two sets, maybe three — echoing from the western stairwell.

She let go of the bolt.

She turned to Mother Vyne, and she said, in her father's calm voice: "I want to read the agreement."`;

export const SALT_AND_HOLLOW: ExampleNovel = {
  slug,
  pitch: 'A keeper pulls her dead brother from the rocks, eight years late.',
  stageBlurb: 'Drafting in progress · 6 of 12 chapters complete.',
  novel: makeNovel({
    id,
    title: 'Salt and Hollow',
    genre: 'Gothic · Coastal Horror',
    stage: 'autonomous_writing',
    progress: 50,
    storySummary:
      "When the sea returns Sera Mar's brother eight years after he drowned, she discovers that the village of Hollow Cove has been keeping a long, quiet bargain with the tide — and that the bargain is breaking. Twelve chapters; she has to decide whether to hold it together or finally let it end.",
    characterSummary:
      'Sera Mar (24, lighthouse-keeper, last of her family\'s line) and Mother Vyne (the village\'s elder council head, who knows exactly what the cove has been hiding).',
    arcSummary:
      'Recovery → suspicion → discovery → confrontation → bargain → reckoning → release.',
  }),
  blueprint: {
    chapters: blueprintChapters.map(c => ({ chapterNumber: c.num, title: c.title, summary: c.summary })),
    targetWordsPerChapter: 5500,
    generatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 4).toISOString(),
    modelId: 'demo-blueprint',
  },
  chapters: [
    makeChapter({ novelId: id, chapterNumber: 1, title: 'The Tide That Returns Things',  content: chapter1 }),
    makeChapter({ novelId: id, chapterNumber: 2, title: 'A Town That Forgets in Tides',  content: chapter2 }),
    makeChapter({ novelId: id, chapterNumber: 3, title: 'The Man Who Should Not Be Wet', content: chapter3 }),
    makeChapter({ novelId: id, chapterNumber: 4, title: 'Salt in the Lamp Oil',          content: chapter4 }),
    makeChapter({ novelId: id, chapterNumber: 5, title: 'Counting the Returned',         content: chapter5 }),
    makeChapter({ novelId: id, chapterNumber: 6, title: 'The Final Stand',               content: chapter6 }),
  ],
  conversation: [
    {
      role: 'assistant',
      content: 'Chapter 6 finished — 5,460 words. Sera holds the bolt, refuses to open the door, asks to read the agreement. Want me to continue into Chapter 7, or pause here?',
    },
    {
      role: 'user',
      content: 'Pause. I want to reread chapter 6 and the conversation with Mother Vyne. Make her sigh more reluctant — right now it reads slightly tired, I want it to read defeated.',
    },
    {
      role: 'assistant',
      content: 'Noted. I\'ll revise the cellar exchange so Vyne reads as a woman who has been holding this bargain alone for forty years and is genuinely relieved that someone has finally come down the stairs and asked. Want me to send the revision before continuing?',
    },
    {
      role: 'user',
      content: 'Yes. Then continue into 7.',
    },
  ],
  characters: [
    {
      name: 'Sera Mar',
      role: 'Protagonist · lighthouse-keeper',
      description: 'Twenty-four. Inherited the light from her father two years ago. Trained to keep records, mend lamps, and not ask questions. The cove has been counting on the third skill more than the first two.',
    },
    {
      name: 'Mother Vyne',
      role: 'Antagonist · cove elder',
      description: 'Sixty-something, formidable, the unspoken matriarch of Hollow Cove. Has held the cellar bolts on the cove\'s behalf for forty years. Would prefer never to have shown them to anyone.',
    },
    {
      name: 'Tobias Mar',
      role: 'The returned',
      description: 'Sera\'s older brother. Drowned at sixteen. Returns, eight years later, in his own body, with their father\'s voice.',
    },
  ],
  worldNotes: [
    'Hollow Cove sits on the southwestern coast of a long, cold island. The lighthouse has been in the Mar family for four generations.',
    'The cove has a standing agreement with the sea: it holds back what the tide tries to return, in exchange for the cove being allowed to exist at all. The agreement is held in the cellar under the chapel, behind a bolted driftwood door.',
    'Salt in the lamp oil is the tide\'s way of starting to renegotiate.',
  ],
};
