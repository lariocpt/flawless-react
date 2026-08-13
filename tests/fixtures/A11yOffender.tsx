import type { FC } from "react";

interface A11yOffenderProps {
  src: string;
  href: string;
}

export const A11yOffender: FC<A11yOffenderProps> = ({ src, href }) => {
  return (
    <section>
      <img src={src} />
      <a href={href} />
      <span role="not-a-role">promo</span>
    </section>
  );
};

export default A11yOffender;
