// The creatures that fly on Max's pages and beside the Cloud widget.
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseCharacters } from "../sdk/src/protocol";
import { CHARACTERS, characterList, MAX_CHARACTERS } from "../shared/characters";
import { parseStudio } from "../shared/cloud-studio";
import { Mascot } from "../src/components/Mascot";
import { AssistantProvider } from "../src/components/AssistantContext";
import { publicEmbedSnippet } from "../src/console/studio/install-snippets";
import { configFromDraft, draftFromConfig } from "../src/lib/assistant-config";
import { DEFAULT_ASSISTANT, resolveAssistant } from "../src/lib/assistant";

describe("character lists", () => {
  it("keep known creatures in order, repeats allowed, at most three", () => {
    expect(characterList(["bee", "bee"])).toEqual(["bee", "bee"]);
    expect(characterList(" Butterfly , bee,dragon, hummingbird, bee")).toEqual(["butterfly", "bee", "hummingbird"]);
    expect(characterList(["bee", "bee", "bee", "bee"])).toHaveLength(MAX_CHARACTERS);
    expect(characterList(["unicorn"])).toBeUndefined();
    expect(characterList(42)).toBeUndefined();
    expect(parseCharacters("bee,BUTTERFLY,firefly,bee,bee")).toEqual(["bee", "butterfly", "bee"]);
    expect(parseCharacters(null)).toEqual([]);
  });

  it("have footage for every creature: video, animated picture and still", () => {
    for (const { id } of CHARACTERS) {
      for (const suffix of ["webm", "webp", "png"]) {
        expect(fs.existsSync(`public/character/${id}.${suffix}`), `${id}.${suffix}`).toBe(true);
      }
    }
    const credits = fs.readFileSync("public/character/CREDITS.txt", "utf8");
    expect(credits).toContain("218571");
    expect(credits).toContain("119339");
  });
});

describe("the owner's choice", () => {
  it("round-trips through the assistant config and reaches the pages", () => {
    const draft = draftFromConfig({ device: "website", characters: ["bee", "butterfly"] }, "en-US");
    expect(draft.characters).toEqual(["bee", "butterfly"]);
    expect(configFromDraft(draft).characters).toEqual(["bee", "butterfly"]);
    expect(configFromDraft({ ...draft, characters: null })).not.toHaveProperty("characters");
    expect(
      resolveAssistant({ ...DEFAULT_ASSISTANT, languages: [], characters: ["butterfly", "nope"] }).characters
    ).toEqual(["butterfly"]);
  });

  it("flies the leader and its companions", () => {
    const html = renderToStaticMarkup(<Mascot characters={["bee", "bee", "butterfly"]} />);
    expect(html).toContain('data-characters="bee bee butterfly"');
    expect(html.match(/\/character\/bee\.webm/g)).toHaveLength(2);
    expect(html).toContain("/character/butterfly.webm");
    expect(html.match(/mascotCompanion /g)).toHaveLength(2);
  });

  it("uses the owner's characters from the assistant, else the hummingbird", () => {
    const owned = renderToStaticMarkup(
      <AssistantProvider value={{ ...DEFAULT_ASSISTANT, characters: ["butterfly"] }}>
        <Mascot />
      </AssistantProvider>
    );
    expect(owned).toContain("/character/butterfly.webm");
    expect(renderToStaticMarkup(<Mascot />)).toContain("/character/hummingbird.webm");
  });
});

describe("the Cloud widget", () => {
  it("keeps the chosen characters and puts them in the snippet", () => {
    const studio = parseStudio({ widget: { characters: ["bee", "butterfly", "griffin"] } }, "openai").value!;
    expect(studio.widget.characters).toEqual(["bee", "butterfly"]);
    expect(parseStudio({}, "openai").value!.widget.characters).toEqual([]);
    const snippet = publicEmbedSnippet("https://max.example", "pub_0123456789abcdef01234567", studio.widget);
    expect(snippet).toContain('data-characters="bee,butterfly"');
    expect(
      publicEmbedSnippet("https://max.example", "pub_0123456789abcdef01234567", { ...studio.widget, characters: [] })
    ).not.toContain("data-characters");
  });
});
