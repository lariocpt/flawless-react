interface Props {
  title: string;
  user: { name: string };
}

export function UsagePropsParam(props: Props) {
  const { user } = props;
  return (
    <div>
      <img src="/avatar.png" alt={user.name} />
      <p>{props.title}</p>
    </div>
  );
}
