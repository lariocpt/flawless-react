import type * as React from "react";

interface Props {
  onSubmit: (data: { name: string; email: string; password: string }) => void;
}

export const SignupForm: React.FC<Props> = ({ onSubmit }) => {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        onSubmit({
          name: String(fd.get("name") ?? ""),
          email: String(fd.get("email") ?? ""),
          password: String(fd.get("password") ?? ""),
        });
      }}
    >
      <label htmlFor="name">Name</label>
      <input id="name" name="name" type="text" />
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" />
      <button type="submit">Sign up</button>
    </form>
  );
};

export default SignupForm;
