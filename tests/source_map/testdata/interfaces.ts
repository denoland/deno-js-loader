interface User {
  name: string;
  age: number;
}

export function createUser(name: string, age: number): User {
  return { name, age };
}

export class UserService {
  private users: User[] = [];

  addUser(name: string, age: number): void {
    this.users.push(createUser(name, age));
  }

  getUsers(): User[] {
    return this.users;
  }
}
