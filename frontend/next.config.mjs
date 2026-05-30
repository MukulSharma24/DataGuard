/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable source maps in production — prevents the minified JS bundle
  // from being reconstructed back into readable source code via .map files
  productionBrowserSourceMaps: false,
};

export default nextConfig;
