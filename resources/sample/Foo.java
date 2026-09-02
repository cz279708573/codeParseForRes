package com.demo;

/**
 * 示例类 Foo，继承 Bar、实现 IFoo
 */
@org.springframework.stereotype.Service
@Logged(Bar.class)
public class Foo extends Bar implements IFoo {

    private int count;
    public static final String TAG = "foo";

    @Override
    public void greet(String name) {
        System.out.println("hi " + name);
        this.count++;
        Bar b = new Bar();
        b.run();
        this.run();
    }

    @Override
    public int counter() {
        return this.count;
    }

    /**
     * 验证形参类型解析：bar 为形参，调用其 run()
     */
    public void echo(Bar bar) {
        bar.run();
    }

}
