#include <assert.h>

unsigned int add3(unsigned int x, unsigned int y, unsigned int z){
  unsigned int r = x + y;
  return r + z;
}

int main(){
  unsigned int a;

  a = add3(1, 2, 3);
  assert(a == 6u);

  a = add3(a, a, a);
  assert(a == 18u);

  return 0;
}
