# Hytils Reborn v2 Data

## `language.json`

This file stores an object of all language data.

The **`regexes`** object maps field names (defined in [`LanguageData.kt`](https://github.com/Polyfrost/Hytils-Reborn/blob/main/src/main/kotlin/org/polyfrost/hytils/client/data/providers/LanguageData.kt)) to either a string (pattern) or an object of the following form to create a single regex pattern:

```ts
{
  // Patterns are wrapped in non-capturing groups and joined with ORs (|)
  "patterns": string[],

  // Optional prefix and suffix to be affixed to the joined patterns
  "prefix"?: string,
  "suffix"?: string
}
```

The **`components`** object maps field names to JSON-serialized [Minecraft text components](https://minecraft.wiki/w/Text_component_format).

The **`strings`** object maps field names to plain strings.

## `cosmetics.json`

This file stores an object of cosmetic data for Hypixel Duels and Arcade, used for the "Hide Duels/Arcade Cosmetics" settings.

```ts
{
  "particles": string[], // Particle identifier paths that should be hidden

  // Rules for hiding items based on description IDs
  "items": {
    "equals": string[],     // Exact matches
    "startsWith": string[], // Prefix matches
    "endsWith": string[],   // Suffix matches
  }
}
```

## `armorstands.json`

This file stores an array of strings containing nametag keywords used by the "Hide Useless Nametags" setting(s).

## `game_identifiers.json`

This file stores an object that maps [HypixelData game type](https://github.com/HypixelDev/HypixelData/blob/master/src/main/java/net/hypixel/data/type/GameType.java) database names and [ModAPI game modes](https://github.com/HypixelDev/ModAPI/blob/master/src/main/java/net/hypixel/modapi/packet/impl/clientbound/event/ClientboundLocationPacket.java) _to_ Hypixel game identifiers (used in `/play`). This is used for the "Auto Queue" setting and the `/requeue` command.

For example, a game type of `HungerGames` with a game mode of `solo_normal` maps to `mw_solo_normal`.

## `game_aliases.json`

This file stores an object that maps game aliases, used for the "Auto-Complete Play Commands" setting, to their corresponding Hypixel game identifiers (used in `/play`).

## `chat_emotes.json`

This file stores an object that maps chat shortcuts to JSON-serialized [Minecraft text components](https://minecraft.wiki/w/Text_component_format) of their full emotes, used for the "Replace Chat Emotes" setting.
