import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, TextInput, View } from "react-native";
import { useState } from "react";

/**
 * Copy and props chosen to break a string-concatenating emitter.
 *
 * Every value here reaches an emitted test TITLE or a regex literal, and the
 * fixture that existed before this one contained no `"` and no `/` — so the
 * "every emitted spec parses" test passed while the tool was writing files jest
 * could not collect. Real app copy has quotes and slashes in it constantly:
 * "24/7", "and/or", 'Say "hi"', "Terms/Privacy".
 */
export default function HostileScreen() {
  const [q, setQ] = useState("");
  return (
    <View>
      <Text>Available 24/7 — see Terms/Privacy</Text>
      <Pressable onPress={() => {}} testID={'say "hi"'}>
        <Text>Save 50/50 split</Text>
      </Pressable>
      <Pressable onPress={() => {}} accessibilityLabel={'the "primary" action'}>
        <Text>Go</Text>
      </Pressable>
      {/* An icon sibling makes the label PARTIAL, so it is emitted as a regex —
          and an unescaped `/` there closes the literal and takes the file out. */}
      <Pressable onPress={() => {}}>
        <Ionicons name="clock" size={16} />
        <Text>24/7 support (a+b)</Text>
      </Pressable>
      <TextInput placeholder={'type "x" or y/z'} value={q} onChangeText={setQ} />
    </View>
  );
}
