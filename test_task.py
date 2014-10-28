'''
Created on 2014-10-25

@author: didia
'''
import unittest
from base_test import DatastoreTest
import task
import user
from task import Task


class TestTask(DatastoreTest):

    def setUp(self):
        super(TestTask, self).setUp()
        self.user = user.create_user("101010", "thefuture2092@gmail.com", "didia")
    
    def test_to_dict_of_Task(self):
        name = "GLO-2100"
        my_task = Task(parent=self.user.key, name=name)
        key = my_task.put()
        task_dict = my_task.to_dict();
        self.assertEqual(key.id(), task_dict.get("id"))
    
    def test_create_task(self):
        name = "GLO_2100"
        description = "Etude Algorithmes et Structure"
        location = "PLT-3920"
        my_task = task.create_task(owner = self.user, name=name, description=description, location=location)
        self.assertEqual(my_task.get("name"), name)
        self.assertEqual(my_task.get("description"), description)
        self.assertEqual(my_task.get("location"), location)
    
    def test_edit_task(self):
        name = "GLO-2100"
        second_name = "GLO-2004"
        my_task = task.create_task(owner = self.user, name = name)
        task.edit_task(owner = self.user, task_id = my_task["id"], name=second_name)
        same_task = task.get_task(owner = self.user, task_id = my_task["id"])
        self.assertEqual(same_task["name"], second_name)
    
    def test_get_task(self):
        name = "GLO-2100"
        my_task = task.create_task(owner = self.user, name = name)
        self.assertEqual(my_task, task.get_task(owner = self.user, task_id = my_task["id"]))
    
    def test_delete_task(self):
        name = "GLO-2100"
        my_task = task.create_task(owner = self.user, name = name)
        task.delete_task(owner = self.user, task_id = my_task["id"])
        self.assertIsNone(task.get_task(owner = self.user, task_id = my_task["id"]))
        
        
        
    
        
        
        


if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()