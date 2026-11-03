// Trivial next.config so detectNextjs()'s looksLikeNext() probe fires on the
// config file as well as on package.json. Nothing here is ever executed.
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
