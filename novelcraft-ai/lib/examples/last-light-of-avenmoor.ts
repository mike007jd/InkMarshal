import { makeChapter, makeNovel, type ExampleNovel } from './types';
import { EXAMPLE_NOVEL_ID_PREFIX } from './prefix';

const slug = 'last-light-of-avenmoor';
const id = `${EXAMPLE_NOVEL_ID_PREFIX}${slug}`;

const blueprintChapters = [
  { num: 1, title: 'The Watch That Stopped',     summary: 'In a city that runs on a single great clock, the clock stops. Iren, an apprentice clockmaker, is the only one who notices first.' },
  { num: 2, title: 'A Letter from the Tower',    summary: 'A summons arrives from the Tower of Hours. Iren learns her late master left her his keys — and his unfinished investigation.' },
  { num: 3, title: 'The Eleventh Gear',          summary: 'In the master\'s workshop, Iren finds an extra gear that should not exist. It is older than the city.' },
  { num: 4, title: 'A City Out of Time',         summary: 'As the gear sits in her pocket, the city begins to rearrange itself around her — buildings out of order, people she does not remember being friends with.' },
  { num: 5, title: 'The Watchman\'s Confession', summary: 'The Watchman of the Tower tells Iren what the eleventh gear was really for, and who built it, and why he took it out a hundred years ago.' },
  { num: 6, title: 'The Last Light of Avenmoor', summary: 'Iren chooses what to do with the gear at midnight, in the great hall of the clock, with the entire city listening.' },
];

const chapter1 = `The clock stopped at twenty-three minutes past three on the seventeenth day of the rain-month, and for almost half an hour Iren Vesh was the only person in Avenmoor who knew.

She had been bent over the back of an old longcase clock in her master's shop — a private piece, no Tower business, no urgency, only the wealthy widow on the cliff road who liked her father's clock to chime more reliably than her late father had — when she heard the silence.

It came in through the open shop door the way a smell does. The square outside, normally full of the polite mechanical chatter of a hundred small clocks in a hundred small windows, had stopped chattering. The silence was not absolute — a dog was barking, two streets over, and a horse complained somewhere on the wet cobbles — but the clocks had stopped, all of them, and without them the city sounded less like itself than Iren had ever heard it sound in her life.

She set down her file. She walked to the door. She looked up.

The Tower of Hours stood at the south end of the square as it had always stood, twelve stories of pale stone, its great copper hands black against the rain. The minute hand was at twenty-three past. The second hand was not moving.

She watched it for a long count of breaths. It did not move.

Around her, slowly, people began to come out of doorways. The greengrocer first — he kept his accounts by the Tower bell and was already counting on his fingers in confusion. Then the apothecary's boy. Then old Halver from the inn, who had not been outside in daylight in nearly a year and whose face, in the wet grey light, looked oddly young.

Nobody spoke. They were all looking at the Tower.

The seconds did not start moving again. The minute hand did not move. Above the square, the Tower stood silent, and the city — the entire careful and over-correct city of Avenmoor, every one of whose habits was timed to the great clock above its head — stood silent with it.

It was Halver who finally spoke. He said, very quietly, the way one speaks at a deathbed: "It hasn't done that since."

He did not finish the sentence.

Iren looked at him, then at the Tower, then back at Halver. Halver was eighty-two. Whatever he was about to compare it to had happened, at the latest, when he was a small boy.

She had been an apprentice clockmaker for nine years. She had inherited the shop from her master only six months ago. She had no business climbing the Tower. She had no key.

She stood in the doorway and watched the rain come down on the unmoving copper hands, and she understood, in the way a clockmaker understands these things, that something had gone wrong that her master had not lived long enough to teach her how to fix.`;

const chapter2 = `The letter came in the late afternoon, two hours after the clock began moving again.

Nobody had announced it. The Tower's bell had not rung the half-hour. The seconds had simply, at some point during the long grey afternoon, started counting again, and the city — relieved, embarrassed, almost guilty — had pretended that it had never noticed they were stopped. The greengrocer went back inside. The apothecary's boy went back to his deliveries. Old Halver returned to the inn. Within an hour the square was full of clocks chattering again, and the silence had become the kind of thing one might have imagined.

Iren did not pretend.

She was at the back of the shop, with the longcase clock\'s movement disassembled across her bench, when the messenger arrived — a thin nervous boy in the grey livery of the Tower, holding an envelope sealed with the dark red wax that nobody in Avenmoor saw twice in a lifetime.

"For Master Iren Vesh," he said.

"Apprentice."

He looked confused. "The seal says Master."

She took the envelope.

The seal was her master's. She knew it the way you know your own hand. Eylan Vesh — no relation, despite the shared name, although she had taken his name at his suggestion when she was sixteen — had used this seal on perhaps three letters in his life, and Iren had filed all of them. This one was new.

She broke the wax. The handwriting was his.

> Iren —
>
> If you are reading this, the clock has stopped, and I am no longer in a position to fix it. Both of these things were inevitable, although I am sorry about the second.
>
> The keys are in the second drawer of the cabinet under the south window. The cabinet itself is locked; the key to the cabinet is taped to the underside of the kettle. Do not laugh. I have been doing this a long time.
>
> Take the keys to the Watchman of the Tower. He will know what they are. Tell him the eleventh gear is missing.
>
> I am sorry I did not tell you any of this in person. There were rules. There still are.
>
> Eylan.

She read the letter twice. Then she read it a third time, because parts of it had not made any sense the first two.

She went to the kitchen. She turned over the kettle.

The key was there.

She unlocked the cabinet. In the second drawer, on a little square of dark blue felt, lay a ring of seven small brass keys. They were old — older than the cabinet, older than the shop, possibly older than the part of the city the shop sat in. Each one had a tiny number stamped on its bow. They were numbered one through seven.

She put them in her pocket.

She went out into the wet evening, and she walked toward the Tower.`;

const chapter3 = `The Watchman of the Tower lived in the clock.

This was not a figure of speech. He had a small set of rooms set into the masonry between the seventh and eighth floors, accessible only by a wrought-iron staircase that wound around the great central spindle of the mechanism. Iren had never been inside the Tower. She had not, before that evening, known anyone who had.

The Watchman opened his door before she could knock.

He was older than she had expected. Older than her master. Older, possibly, than old Halver. His beard was the colour of unpolished pewter, and his eyes — close-set, very pale — were the eyes of a man who had spent fifty years watching small things move in unison.

"Vesh\'s apprentice," he said.

"Iren."

"He sent you the keys."

"He sent me the keys."

He stepped aside. "Then you had better come in."

The rooms were warm — warmer than they had any right to be in stone walls in the rain-month — and they smelled, very faintly, of brass polish and old paper. There was a kettle on a small iron stove. There was a long table covered in clock parts. There was, on a shelf above the table, a row of small leather-bound books that looked, from where Iren was standing, exactly like her master\'s logbooks.

"The eleventh gear," she said.

"Ah." The Watchman closed the door behind her. "Yes. About that."

He went to the long table. He cleared a space at one end with the back of his hand. He gestured for her to sit.

She sat.

"Avenmoor\'s clock," he said, "has ten gears. Everyone in the city knows this. Every apprentice in your trade is taught it in their first year, and is shown the pattern, and is told that the genius of it is that ten gears is the smallest number that produces a perfect ten-thousand-year drift. That is what the children\'s books say. That is what the clockmakers\' manuals say. That is what the Tower itself, on its public plaque, says."

"It has eleven."

"It was built with eleven. About a hundred years ago, my predecessor — a man named Tannet, who I never met — took the eleventh out. He had his reasons. He wrote them down. The book is on that shelf, third from the left. If you want to read it, you may, but I will save you the time: he took it out because, when it was in, the clock did not measure time. It measured something else. And the city — the entire careful and over-correct city of Avenmoor — was beginning to obey it."

Iren put her hand into her pocket and touched the ring of brass keys.

"Where," she said, "is the eleventh gear now?"

"That," said the Watchman, "is what we were hoping you would tell us. Your master spent the last seven years looking for it. We assumed, when he died, that he had failed."

"The clock stopped today."

"Yes."

"For half an hour."

"Yes."

"That means somebody put it back in."

The Watchman looked at her for a long moment.

"It does," he said. "Yes. Somebody did."`;

const chapter4 = `She walked home through a city she did not entirely recognize.

Avenmoor had — like all cities — its small daily inconsistencies: the lamplighter who began on the wrong street, the bakery that had moved one block north and not yet updated its sign, the alley by the cathedral that one was always slightly surprised to find on the right rather than the left. These had always been the city's small jokes about itself. Iren had grown up with them. They had been comforting.

Tonight they were not jokes.

The lamplighter began on the wrong street, and the wrong street was not a street she remembered Avenmoor having. The bakery had moved three blocks north, and was now a fishmonger\'s, and the fishmonger had been in the same spot since her grandmother was a girl. The alley by the cathedral was on neither side. It simply was not there.

She walked the long way home. She did not let her hand out of her pocket, where the ring of keys sat warm against her palm. She had the strong sense — the sense one has in dreams — that if she let go of the keys, she would no longer be entirely sure who she was, or what she was doing in this particular street at this particular hour.

By the time she reached the shop, the rain had stopped. The square was full of small clocks chattering at each other. Her own door was where it had always been.

Her neighbour was on the step, waiting for her.

This was not surprising in itself; her neighbour was a kind woman who liked Iren and frequently brought her bread. What was surprising was that her neighbour smiled at her, and embraced her, and said: "I'm so glad you came. Halver was asking after you."

Iren had not, until that moment, ever been close to old Halver. She had served him beer at the inn, on the rare occasions her master sent her to fetch supper. She had not, in nine years, ever been the sort of acquaintance one asked after.

She returned the embrace. She made a polite noise. She let herself into the shop.

She locked the door behind her. She drew the bolt.

She put her hand into her pocket and lifted out the ring of brass keys, and as she set them on the workbench she had the cold and exact knowledge that she was now, in the eyes of her city and her neighbours and possibly the Tower itself, a slightly different person than she had been that morning — a person whom Halver had always asked after, a person whose bakery had always been a fishmonger\'s, a person whose master had always intended for her to take the keys.

She had not yet put the eleventh gear back into the clock.

She was beginning to understand that she was the only person in Avenmoor who would notice, when she did.`;

const chapter5 = `She found the eleventh gear in her master\'s desk on the morning of the third day.

It had not, she was reasonably sure, been there the morning before. She had searched the desk on the first day, after sleeping badly. She had searched it again on the second day, more carefully. On the third morning, she came down to make tea, and the gear was sitting on top of her master\'s blotter as if it had been there all along.

It was small. Smaller than she had expected. Brass, like the keys, but darker — the dark of metal that has been held by many hands over a long time. It had eleven teeth. Each tooth was filed to a tiny, precise asymmetry that Iren, with nine years of training, recognized at once: it was the kind of asymmetry that a clockmaker introduced when the gear was meant to do something other than measure.

She wrapped it in a clean square of linen. She put it in her inner pocket. She walked to the Tower.

The Watchman was in his rooms, eating bread and writing in a logbook. He did not look up when she came in.

She set the linen-wrapped gear on the table.

He set down his pen.

"Where," he said.

"On my master\'s desk. This morning. It was not there yesterday."

"You\'re certain."

"I am."

He unwrapped the linen. He picked the gear up. He held it to the light from the small window. He turned it slowly, looking at the teeth, the bow, the small worn nick in the rim that Iren had not noticed until that moment but that he, evidently, recognized.

He set it down again. He sat back. He closed his eyes.

"Tannet did not take this out," he said, "to keep the city from changing. The city had been changing already, slowly, in small ways, for a hundred years before he was born. The gear was making it stop. It is — it was — a brake."

"On what."

"On us. On the city. On the way the city was, when the gear was first installed. The clock did not measure time, Iren. It held time still. It said: this is Avenmoor, this is what its streets are, these are the people who live in it, this is where the bakery is. And it held all of those things in place. The eleventh gear was the holding. When Tannet took it out, the city began, very slowly, to drift again — to remember things differently from one day to the next, to swap a fishmonger for a bakery, to make old Halver into your neighbour\'s old friend instead of a stranger. And we have been drifting for a hundred years. Most people do not notice. Most people, the changes happen to slowly enough that they only feel like the small jokes a city tells itself."

"And now it\'s back in."

"And now it\'s back in. And the city — your city — is beginning to fix itself. Not into what it was a hundred years ago. Into what someone, very recently, decided it should be."

She thought about Halver. She thought about her neighbour\'s embrace.

"Who put it back in," she said.

"That," said the Watchman, "is the question."

"And the answer."

He looked at her for a long moment.

"My predecessor," he said, "had three apprentices. Two of them died young. The third was your master. Who, when he was a young man, was very much in love with a woman who has not, in the records, existed for sixty years."

She stared at him.

"He didn\'t."

"He had seven years," said the Watchman, gently, "and the keys. And he was, by any measure I am qualified to make, a great clockmaker. Yes. I think he did."`;

const chapter6 = `At a quarter to midnight on the seventh day, Iren climbed the Tower.

She climbed it alone. The Watchman had offered to come; she had refused. He had not pressed. He had instead given her a small lantern, a thicker coat, and a piece of bread wrapped in waxed paper, and had stood at the bottom of the iron staircase with his hand raised in a gesture that might have been a blessing and might have been a goodbye.

The eleventh gear was in her pocket, wrapped in the linen square. She did not yet know whether she was going to leave it where her master had put it, or take it out again. She had been arguing with herself about it for three days. She had not won the argument either way.

She climbed past the Watchman\'s rooms. She climbed past the bell-chamber. She climbed past the small landing where the apprentices, in the days when the Tower had had apprentices, had slept. She climbed up into the great brass throat of the clock itself, where the gears turned in their slow oiled certainty, and she stood on the small iron platform her master had taught her to think of, even when she was a child, as the heart of the city.

She took the gear out. She held it to the light of the lantern.

It would be very easy, now, to remove it. The Watchman had told her, when he had given her the keys, exactly how. She had the tools in her coat. She had the knowledge — nine years of it — in her hands.

If she removed it, the city would begin to drift again. The bakery would, over weeks and months, become a bakery once more. Old Halver would become a stranger. Her neighbour, who had been embracing her every morning for three days now, would go back to being the kind woman who occasionally brought her bread. The street the lamplighter began on would, slowly, stop being a street at all.

If she left it in, the city would set. It would become, permanently, the city her master had spent the last seven years rebuilding around the memory of a woman who had not existed for sixty years. Iren did not know who that city was for. Iren did not know whether, in that city, she herself was the same person.

Below her, the bells in the chamber began to count toward midnight.

She stood for a long time with the gear in her palm. She watched the great brass mechanism turn around her. She listened to the bells.

At the last stroke, she did neither of the things she had been arguing with herself about.

She wound the gear, very carefully, in a fresh square of linen. She put it in the small lead-lined box her master had used for his most precious tools. She closed the box. She locked it with the smallest of the seven brass keys.

Then she sat down on the iron platform, in the heart of the clock, and she wrote — in her master\'s careful even hand, on the inside cover of his last logbook — the date, and the time, and a short clear sentence.

> The eleventh gear of Avenmoor is in the lead box on the high shelf in the workshop. The keeper of it, from this date, is Iren Vesh, apprentice. The next keeper will be of her choosing. The gear is not to be returned to the clock without a full council of the citizens of Avenmoor, voting in the great hall, in daylight, knowing what they are voting on.
>
> The city will drift. Let it drift. A city that drifts is a city that is alive.
>
> — I.V., the seventeenth night of the rain-month.

She closed the logbook. She put it in her coat. She climbed back down the stairs.

The Watchman was still at the foot of the staircase. He did not ask. She did not say. She handed him the small lantern and the unfolded waxed paper, with the bread untouched inside it, and she walked out into the wet midnight air of a city that, for the first time in a hundred years, would be allowed to become whatever it was going to become.

The last light of Avenmoor, that night, was not the great clock at the south end of the square. It was the small oil lamp she lit, when she got home, in her master\'s window. She left it burning until morning.

It was the only light in the city, in the end, that she had any say in at all.`;

export const LAST_LIGHT_OF_AVENMOOR: ExampleNovel = {
  slug,
  pitch: 'An apprentice clockmaker inherits a city\'s final choice.',
  stageBlurb: 'Completed manuscript · 6 chapters, polished and unified.',
  novel: makeNovel({
    id,
    title: 'Last Light of Avenmoor',
    genre: 'Literary Fantasy',
    stage: 'completed',
    progress: 100,
    storySummary:
      "When the great clock of Avenmoor stops for half an hour, apprentice clockmaker Iren Vesh inherits her late master\'s investigation, his keys, and his unanswered question: what do you do when you discover the city you live in is not the city it remembers being? Six chapters; one quiet, irrevocable choice.",
    characterSummary:
      'Iren Vesh (mid-twenties, apprentice clockmaker) and the Watchman of the Tower of Hours, the only other person who knows what the eleventh gear is for.',
    arcSummary:
      'Anomaly → inheritance → discovery → drift → confession → choice.',
  }),
  blueprint: {
    chapters: blueprintChapters.map(c => ({ chapterNumber: c.num, title: c.title, summary: c.summary })),
    targetWordsPerChapter: 4500,
    generatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString(),
    modelId: 'demo-blueprint',
  },
  chapters: [
    makeChapter({ novelId: id, chapterNumber: 1, title: 'The Watch That Stopped',     content: chapter1 }),
    makeChapter({ novelId: id, chapterNumber: 2, title: 'A Letter from the Tower',    content: chapter2 }),
    makeChapter({ novelId: id, chapterNumber: 3, title: 'The Eleventh Gear',          content: chapter3 }),
    makeChapter({ novelId: id, chapterNumber: 4, title: 'A City Out of Time',         content: chapter4 }),
    makeChapter({ novelId: id, chapterNumber: 5, title: "The Watchman's Confession",  content: chapter5 }),
    makeChapter({ novelId: id, chapterNumber: 6, title: 'The Last Light of Avenmoor', content: chapter6 }),
  ],
  conversation: [
    { role: 'assistant', content: 'Final unification pass complete. Chapter 5 reference to the bakery now reconciles with its first appearance in Chapter 4. Manuscript ready for export.' },
    { role: 'user',      content: 'Beautiful. Export TXT and DOCX.' },
    { role: 'assistant', content: 'Exporting now. Both formats will be available in the Files panel in a moment.' },
  ],
  characters: [
    {
      name: 'Iren Vesh',
      role: 'Protagonist · apprentice clockmaker',
      description: 'Twenty-five. Inherited her master\'s shop six months before the story opens. Nine years of training. No family. Took her master\'s name when she was sixteen.',
    },
    {
      name: 'Eylan Vesh',
      role: 'The master (deceased)',
      description: 'Iren\'s late master. Spent the last seven years of his life trying to undo a thing he had done as a young man. He did not live to finish — but he left her his keys, and a letter, and a city that was beginning, very slowly, to remember itself the way he had wanted it to.',
    },
    {
      name: 'The Watchman',
      role: 'Tower keeper',
      description: 'Older than anyone else in the book. Has lived inside the clock for fifty years. The only other person in Avenmoor who understands what the eleventh gear is, and what the cost of returning it has been.',
    },
  ],
  worldNotes: [
    'Avenmoor is a small city built around a single great mechanical clock — the Tower of Hours — which has been the city\'s civic and emotional centre for a thousand years.',
    'The clock was originally built with eleven gears. The eleventh was removed by the Watchman\'s predecessor, Tannet, a hundred years ago. Removing it allowed the city to drift slowly through small variations of itself; reinstalling it locks the city into one specific version.',
    'Eylan Vesh — Iren\'s late master — was Tannet\'s third apprentice. He spent the last seven years of his life trying to put the gear back, in pursuit of a memory of a woman who has not existed in the city\'s records for sixty years.',
  ],
};
