import { Link, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { login } from "../lib/api";

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    await login({ email, password });
    router.replace("/(tabs)");
  }

  return (
    <View className="flex-1 justify-center p-6">
      <Text className="mb-4 text-2xl">Welcome back</Text>
      <TextInput
        placeholder="you@example.com"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        placeholder="••••••••"
        secureTextEntry
        autoComplete="current-password"
        value={password}
        onChangeText={setPassword}
      />
      {/* The submit control: a ternary whose condition reduces at the initial
          render, so the label IS knowable — "Sign in", not "unaddressable". */}
      <Pressable onPress={onSubmit} disabled={busy} className="mt-4 rounded-md py-3">
        {busy ? (
          <ActivityIndicator />
        ) : (
          <Text className="text-center">Sign in</Text>
        )}
      </Pressable>
      <Link href="/signup" className="mt-4 text-center">
        Create an account
      </Link>
    </View>
  );
}
